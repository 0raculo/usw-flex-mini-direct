import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import test from "node:test";
import { DEFAULT_KEY, decodePacket, encodePacket } from "../src/protocol.mjs";

const mac = "02:00:00:00:00:02";
const key = "00112233445566778899aabbccddeeff";
const password = "integration-password-123";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, child) {
  let failure = "";
  child.stderr.on("data", (chunk) => { failure += chunk.toString(); });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Servidor terminou: " + failure);
    try {
      const response = await fetch(url + "/api/health");
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("Servidor não arrancou: " + failure);
}

async function waitUntil(check, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Condição não foi atingida.");
}

test("reset, TLS, adoção e reposição funcionam pelo último IP sem descoberta UDP", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "usw-recovery-test-"));
  const keyFile = path.join(dataDir, "bootstrap.key");
  await fs.writeFile(keyFile, key, { mode: 0o600 });
  const certificate = path.join(dataDir, "cert.pem");
  const certificateKey = path.join(dataDir, "key.pem");
  const generated = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", certificateKey, "-out", certificate,
    "-subj", "/CN=127.0.0.1", "-days", "1"
  ], { stdio: "ignore" });
  if (generated.status !== 0) throw new Error("openssl não conseguiu criar o certificado de teste.");

  let channelRequest = null;
  const channel = tls.createServer({
    cert: await fs.readFile(certificate),
    key: await fs.readFile(certificateKey)
  }, (socket) => {
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => {
      try { channelRequest = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
      socket.end("ok");
    });
  });
  await new Promise((resolve) => channel.listen(0, "127.0.0.1", resolve));

  const port = await freePort();
  const url = "http://127.0.0.1:" + port;
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      INFORM_URL: url + "/inform",
      SWITCH_MAC: mac,
      BOOTSTRAP_KEY_FILE: keyFile,
      ADMIN_PASSWORD: password,
      DISCOVERY_ENABLED: "0",
      DISCOVERY_LISTEN_ENABLED: "0",
      CONTROLLER_CHANNEL_PORT: String(channel.address().port),
      CONTROLLER_CHANNEL_TIMEOUT_MS: "500",
      RECOVERY_INTERVAL_MS: "50",
      RECOVERY_SAVED_ADDRESS_DELAY_MS: "100",
      RECOVERY_DARK_TIMEOUT_MS: "10000"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => channel.close(resolve));
    await fs.rm(dataDir, { recursive: true });
  });
  await waitForServer(url, child);

  const ports = [1, 2, 3, 4, 5].map((port_idx) => ({
    port_idx,
    up: port_idx === 1,
    speed: port_idx === 1 ? 1000 : 0,
    is_uplink: port_idx === 1
  }));
  const inform = (packetKey, cfgversion, defaults = false) => encodePacket({
    model: "USMINI",
    model_display: "USW Flex Mini",
    serial: "RECOVERY01",
    version: "2.1.6.762",
    ip: "127.0.0.1",
    hostname: "USW-Recovery",
    cfgversion,
    default: defaults,
    port_table: ports,
    switch_caps: { max_mirror_sessions: 1, vlan_caps: 2 }
  }, packetKey, { mac });
  const postInform = async (packetKey, cfgversion, defaults = false) => {
    const response = await fetch(url + "/inform", {
      method: "POST",
      headers: { "Content-Type": "application/x-binary" },
      body: inform(packetKey, cfgversion, defaults)
    });
    assert.equal(response.status, 200);
    return { packet: Buffer.from(await response.arrayBuffer()), key: packetKey };
  };

  await postInform(key, "before");
  const login = await fetch(url + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const { csrf } = await login.json();
  const authenticated = (pathname, options = {}) => fetch(url + pathname, {
    ...options,
    headers: {
      Cookie: cookie,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.method && options.method !== "GET" ? { "X-CSRF-Token": csrf } : {})
    }
  });
  const getState = async () => (await authenticated("/api/state")).json();

  const initial = await getState();
  const draft = {
    ports: initial.config.ports.map((item) => ({
      ...item,
      vlan: item.idx === 2 ? 42 : item.vlan
    }))
  };
  const preview = await (await authenticated("/api/preview", {
    method: "POST",
    body: JSON.stringify({ draft })
  })).json();
  const applied = await (await authenticated("/api/apply", {
    method: "POST",
    body: JSON.stringify({ token: preview.token })
  })).json();
  await postInform(key, "before");
  await postInform(key, applied.operation.cfgversion);

  const resetResponse = await authenticated("/api/reset", {
    method: "POST",
    body: JSON.stringify({ mac })
  });
  assert.equal(resetResponse.status, 202);
  const reset = await resetResponse.json();
  const resetReply = await postInform(key, applied.operation.cfgversion);
  assert.equal(decodePacket(resetReply.packet, key).payload._type, "setdefault");

  let lastState = null;
  let channelState;
  try {
    channelState = await waitUntil(async () => {
      lastState = await getState();
      return lastState.recovery?.status === "waiting-factory-inform" ? lastState : null;
    });
  } catch (error) {
    throw new Error(error.message + " " + JSON.stringify({
      recovery: lastState?.recovery,
      discovery: lastState?.discovery,
      device: lastState?.device
    }));
  }
  assert.equal(channelState.recovery.targetIp, "127.0.0.1");
  await waitUntil(() => channelRequest);
  assert.equal(channelRequest.type, "adopt");
  assert.equal(channelRequest.mac, mac);
  assert.equal(channelRequest.url, url + "/inform");
  assert.equal(channelRequest.key, null);

  const factoryReply = await postInform(DEFAULT_KEY, "factory", true);
  const adoption = decodePacket(factoryReply.packet, DEFAULT_KEY).payload;
  assert.equal(adoption._type, "setparam");
  const ownKey = adoption.mgmt_cfg.match(/^authkey=([0-9a-f]{32})$/m)?.[1];
  assert.match(ownKey, /^[0-9a-f]{32}$/);

  const ownReply = await postInform(ownKey, "factory", false);
  const restore = decodePacket(ownReply.packet, ownKey).payload;
  assert.equal(restore._type, "setparam");
  assert.match(restore.system_cfg, /switch\.port\.2\.pvid=42/);
  await postInform(ownKey, restore.cfgversion, false);

  const complete = await waitUntil(async () => {
    const state = await getState();
    return state.recovery?.status === "complete" ? state : null;
  });
  assert.equal(complete.config.ports.find((item) => item.idx === 2).vlan, 42);
  assert.equal(complete.device.adopted, true);
  assert.equal(complete.device.defaultKey, false);
  assert.equal(complete.discovery.enabled, false);
  assert.equal(complete.recovery.snapshotId, reset.snapshot);
});

test("adoção manual por IP e MAC valida o endereço e abre o canal sem descoberta", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "usw-manual-adopt-test-"));
  const keyFile = path.join(dataDir, "bootstrap.key");
  await fs.writeFile(keyFile, key, { mode: 0o600 });
  const certificate = path.join(dataDir, "cert.pem");
  const certificateKey = path.join(dataDir, "key.pem");
  const generated = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", certificateKey, "-out", certificate,
    "-subj", "/CN=127.0.0.1", "-days", "1"
  ], { stdio: "ignore" });
  if (generated.status !== 0) throw new Error("openssl não conseguiu criar o certificado de teste.");

  let channelRequest = null;
  const channel = tls.createServer({
    cert: await fs.readFile(certificate),
    key: await fs.readFile(certificateKey)
  }, (socket) => {
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => {
      try { channelRequest = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
      socket.end("ok");
    });
  });
  await new Promise((resolve) => channel.listen(0, "0.0.0.0", resolve));

  const port = await freePort();
  const url = "http://127.0.0.1:" + port;
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      INFORM_URL: url + "/inform",
      BOOTSTRAP_KEY_FILE: keyFile,
      ADMIN_PASSWORD: password,
      DISCOVERY_ENABLED: "0",
      DISCOVERY_LISTEN_ENABLED: "0",
      CONTROLLER_CHANNEL_PORT: String(channel.address().port),
      CONTROLLER_CHANNEL_TIMEOUT_MS: "500"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => channel.close(resolve));
    await fs.rm(dataDir, { recursive: true });
  });
  await waitForServer(url, child);

  const login = await fetch(url + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const { csrf } = await login.json();
  const adopt = (body) => fetch(url + "/api/adopt", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(body)
  });
  const sendInform = async (packetKey, defaults) => {
    const response = await fetch(url + "/inform", {
      method: "POST",
      headers: { "Content-Type": "application/x-binary" },
      body: encodePacket({
        model: "USMINI",
        model_display: "USW Flex Mini",
        serial: "MANUAL01",
        version: "2.1.6.762",
        ip: "127.0.0.1",
        hostname: "USW-Manual",
        cfgversion: "manual-factory",
        default: defaults,
        port_table: [1, 2, 3, 4, 5].map((port_idx) => ({ port_idx, up: port_idx === 1, is_uplink: port_idx === 1 })),
        switch_caps: { max_mirror_sessions: 1, vlan_caps: 2 }
      }, packetKey, { mac })
    });
    assert.equal(response.status, 200);
    return Buffer.from(await response.arrayBuffer());
  };

  assert.equal((await adopt({ ip: "127.0.0.1" })).status, 409);
  const invalidIp = await adopt({ ip: "999.1.1.1", mac });
  assert.equal(invalidIp.status, 400);
  assert.equal((await invalidIp.json()).code, "INVALID_IP");
  const invalidMac = await adopt({ ip: "127.0.0.1", mac: "not-a-mac" });
  assert.equal(invalidMac.status, 400);
  assert.equal((await invalidMac.json()).code, "INVALID_MAC");

  const accepted = await adopt({ ip: "127.0.0.1", mac });
  assert.equal(accepted.status, 202);
  const body = await accepted.json();
  assert.equal(body.recovery.targetMac, mac);
  assert.equal(body.recovery.targetIp, "127.0.0.1");
  await waitUntil(() => channelRequest);
  assert.equal(channelRequest.type, "adopt");
  assert.equal(channelRequest.mac, mac);
  assert.equal(channelRequest.url, url + "/inform");
  assert.equal(channelRequest.key, null);

  channelRequest = null;
  const updated = await adopt({ ip: "127.0.0.1", mac });
  assert.equal(updated.status, 202);
  const updatedBody = await updated.json();
  assert.equal(updatedBody.updated, true);
  assert.equal(updatedBody.recovery.targetIp, "127.0.0.1");
  await waitUntil(() => channelRequest);
  assert.equal(channelRequest.mac, mac);

  const factoryReply = decodePacket(await sendInform(DEFAULT_KEY, true), DEFAULT_KEY).payload;
  assert.equal(factoryReply._type, "setparam");
  const ownKey = factoryReply.mgmt_cfg.match(/^authkey=([0-9a-f]{32})$/m)?.[1];
  assert.match(ownKey, /^[0-9a-f]{32}$/);
  await sendInform(ownKey, false);
  const state = await (await fetch(url + "/api/state", { headers: { Cookie: cookie } })).json();
  assert.equal(state.device.adopted, true);
  assert.equal(state.device.defaultKey, false);
  assert.equal(state.recovery.status, "complete");
});
