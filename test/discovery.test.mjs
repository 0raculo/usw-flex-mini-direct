import assert from "node:assert/strict";
import dgram from "node:dgram";
import test from "node:test";
import { discoverDevices, expandTargets, listenForDevices, parseDiscoveryPacket } from "../src/discovery.mjs";

const mac = "74:83:c2:0f:39:35";

function tlv(type, value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const header = Buffer.from([type, 0, 0]);
  header.writeUInt16BE(data.length, 1);
  return Buffer.concat([header, data]);
}

function discoveryPacket({ factory = true, ip = "192.0.2.96" } = {}) {
  const macBytes = mac.split(":").map((part) => Number.parseInt(part, 16));
  const ipBytes = ip.split(".").map(Number);
  const payload = Buffer.concat([
    tlv(0x02, Buffer.from([...macBytes, ...ipBytes])),
    tlv(0x01, Buffer.from(macBytes)),
    tlv(0x03, "6.6.55"),
    tlv(0x0a, Buffer.from([0, 0, 0, 42])),
    tlv(0x0b, "USW-FLEX-MINI"),
    tlv(0x15, "USMINI"),
    tlv(0x16, "6.6.55"),
    tlv(0x17, Buffer.from([factory ? 1 : 0]))
  ]);
  const header = Buffer.from([2, 6, 0, 0]);
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

test("interpreta anúncio V2 e o estado de fábrica", () => {
  const info = parseDiscoveryPacket(discoveryPacket());
  assert.equal(info.mac, mac);
  assert.equal(info.ip, "192.0.2.96");
  assert.equal(info.hostname, "USW-FLEX-MINI");
  assert.equal(info.model, "USMINI");
  assert.equal(info.firmware, "6.6.55");
  assert.equal(info.uptime, 42);
  assert.equal(info.defaultKey, true);
});

test("expande CIDR sem rede nem broadcast", () => {
  assert.deepEqual(expandTargets(["192.168.1.0/30"]), ["192.168.1.1", "192.168.1.2"]);
  assert.deepEqual(expandTargets(["192.168.1.96"]), ["192.168.1.96"]);
  assert.throws(() => expandTargets(["10.0.0.0/8"]), /4096/);
});

test("faz sondagem UDP unicast e remove respostas duplicadas por MAC", async () => {
  const responder = dgram.createSocket("udp4");
  await new Promise((resolve) => responder.bind(0, "127.0.0.1", resolve));
  const answer = discoveryPacket({ ip: "127.0.0.1" });
  responder.on("message", (_message, remote) => responder.send(answer, remote.port, remote.address));
  try {
    const devices = await discoverDevices({ targets: ["127.0.0.1"], port: responder.address().port, timeoutMs: 80 });
    assert.equal(devices.length, 1);
    assert.equal(devices[0].mac, mac);
    assert.equal(devices[0].defaultKey, true);
  } finally {
    await new Promise((resolve) => responder.close(resolve));
  }
});

test("recebe um anúncio passivo encaminhado por relay", async () => {
  let received;
  const listener = await listenForDevices({
    port: 0,
    onDevice: (device) => { received = device; }
  });
  const sender = dgram.createSocket("udp4");
  try {
    const port = listener.address().port;
    await new Promise((resolve) => sender.send(discoveryPacket({ ip: "192.0.2.96" }), port, "127.0.0.1", resolve));
    for (let attempt = 0; attempt < 20 && !received; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(received.mac, mac);
    assert.equal(received.ip, "192.0.2.96");
    assert.equal(received.passive, true);
  } finally {
    sender.close();
    await new Promise((resolve) => listener.close(resolve));
  }
});
