import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decodePacket, DEFAULT_KEY, encodePacket } from "../src/protocol.mjs";

const mac = "02:00:00:00:00:01";
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
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Servidor terminou: ${failure}`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Servidor não arrancou: ${failure}`);
}

test("aplicar mirroring mantém portas e configuração após o inform de confirmação", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "usw-direct-test-"));
  const keyFile = path.join(dataDir, "bootstrap.key");
  await fs.writeFile(keyFile, key, { mode: 0o600 });
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      INFORM_URL: `http://127.0.0.1:${port}/inform`,
      SWITCH_MAC: mac,
      BOOTSTRAP_KEY_FILE: keyFile,
      ADMIN_PASSWORD: password
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await fs.rm(dataDir, { recursive: true });
  });
  await waitForServer(url, child);

  const inform = (cfgversion, portTable) => encodePacket({
    model: "USMINI",
    model_display: "USW Flex Mini",
    serial: "TEST0001",
    version: "2.1.6.762",
    ip: "192.0.2.10",
    hostname: "USW-Test",
    cfgversion,
    port_table: portTable,
    switch_caps: { max_mirror_sessions: 1, vlan_caps: 2 }
  }, key, { mac });
  const postInform = (body) => fetch(`${url}/inform`, {
    method: "POST",
    headers: { "Content-Type": "application/x-binary" },
    body
  });
  const ports = [1, 2, 3, 4, 5].map((port_idx) => ({
    port_idx,
    up: port_idx === 1,
    speed: port_idx === 1 ? 1000 : 0,
    media: "GE",
    is_uplink: port_idx === 1
  }));
  assert.equal((await postInform(inform("version-before", ports))).status, 200);

  const login = await fetch(`${url}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const { csrf } = await login.json();
  const authenticated = async (pathname, options = {}) => fetch(`${url}${pathname}`, {
    ...options,
    headers: {
      Cookie: cookie,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.method && options.method !== "GET" ? { "X-CSRF-Token": csrf } : {})
    }
  });

  const initial = await (await authenticated("/api/state")).json();
  assert.deepEqual(initial.config.ports.map((item) => item.idx), [1, 2, 3, 4, 5]);
  assert.equal(initial.device.modelDisplay, "USW Flex Mini");
  const draft = {
    ports: initial.config.ports.map((item) => ({
      idx: item.idx,
      name: item.name,
      vlan: item.vlan,
      mirrorSource: item.idx === 2 ? 1 : null
    }))
  };
  const preview = await (await authenticated("/api/preview", {
    method: "POST",
    body: JSON.stringify({ draft })
  })).json();
  assert.match(preview.changes[0], /porta 1/);
  const applied = await (await authenticated("/api/apply", {
    method: "POST",
    body: JSON.stringify({ token: preview.token })
  })).json();
  assert.equal(applied.queued, true);

  // The next inform receives the queued system_cfg. The switch then reports
  // the new cfgversion on its following inform, where port_table may be absent.
  assert.equal((await postInform(inform("version-before", ports))).status, 200);
  const afterDelivery = await (await authenticated("/api/state")).json();
  assert.deepEqual(afterDelivery.config.ports.map((item) => item.idx), [1, 2, 3, 4, 5], JSON.stringify(afterDelivery.config.ports));
  assert.equal((await postInform(inform(applied.operation.cfgversion, []))).status, 200);
  const confirmed = await (await authenticated("/api/state")).json();
  assert.equal(confirmed.operation.state, "applied");
  assert.equal(confirmed.config.ports.length, 5, JSON.stringify(confirmed.config.ports));
  assert.equal(confirmed.config.ports.find((item) => item.idx === 2)?.mirrorSource, 1, JSON.stringify(confirmed.config.ports));
  assert.equal(confirmed.config.ports.find((item) => item.idx === 1)?.up, true, JSON.stringify(confirmed.config.ports));
});

test("aceita um switch de fábrica e entrega uma chave própria na adoção", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "usw-direct-adopt-"));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      INFORM_URL: `http://127.0.0.1:${port}/inform`,
      SWITCH_MAC: mac,
      ADMIN_PASSWORD: password
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await fs.rm(dataDir, { recursive: true });
  });
  await waitForServer(url, child);

  const sendInform = async (key, defaults) => {
    const packet = encodePacket({
      model: "USMINI",
      model_display: "USW Flex Mini",
      serial: "TEST0002",
      version: "2.1.6.762",
      ip: "192.0.2.11",
      hostname: "USW-Factory",
      cfgversion: "factory-version",
      default: defaults,
      port_table: [1, 2, 3, 4, 5].map((port_idx) => ({ port_idx, up: port_idx === 1, is_uplink: port_idx === 1 })),
      switch_caps: { max_mirror_sessions: 1, vlan_caps: 2 }
    }, key, { mac });
    const response = await fetch(`${url}/inform`, {
      method: "POST",
      headers: { "Content-Type": "application/x-binary" },
      body: packet
    });
    assert.equal(response.status, 200);
    return Buffer.from(await response.arrayBuffer());
  };

  const factoryReply = await sendInform(DEFAULT_KEY, true);
  assert.equal(decodePacket(factoryReply, DEFAULT_KEY).payload._type, "noop");
  const login = await fetch(`${url}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const { csrf } = await login.json();
  const headers = { Cookie: cookie, "X-CSRF-Token": csrf, "Content-Type": "application/json" };
  const before = await (await fetch(`${url}/api/state`, { headers })).json();
  assert.equal(before.device.defaultKey, true);
  assert.equal(before.device.adopted, false);

  const adoption = await (await fetch(`${url}/api/adopt`, { method: "POST", headers, body: "{}" })).json();
  assert.equal(adoption.queued, true);
  const adoptionReply = decodePacket(await sendInform(DEFAULT_KEY, true), DEFAULT_KEY).payload;
  const ownKey = adoptionReply.mgmt_cfg.match(/^authkey=([0-9a-f]{32})$/m)?.[1];
  assert.match(ownKey, /^[0-9a-f]{32}$/);

  await sendInform(ownKey, false);
  const after = await (await fetch(`${url}/api/state`, { headers })).json();
  assert.equal(after.device.adopted, true);
  assert.equal(after.adoption.pending, false);
});
