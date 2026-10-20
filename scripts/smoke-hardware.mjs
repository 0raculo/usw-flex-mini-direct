import process from "node:process";

const baseUrl = String(process.env.BASE_URL || "").replace(/\/$/, "");
const password = String(process.env.ADMIN_PASSWORD || "");
const timeoutMs = Math.max(10_000, Number(process.env.SMOKE_TIMEOUT_MS || 420_000));

if (!baseUrl || !password) {
  console.error("Defina BASE_URL e ADMIN_PASSWORD.");
  process.exit(2);
}

function operationalState(state) {
  return {
    device: state.device && {
      mac: state.device.mac,
      firmware: state.device.firmware,
      ip: state.device.ip,
      online: state.device.online,
      adopted: state.device.adopted,
      defaultKey: state.device.defaultKey,
      cfgversion: state.device.cfgversion
    },
    discoveryEnabled: state.discovery?.enabled,
    recovery: state.recovery && {
      mode: state.recovery.mode,
      status: state.recovery.status,
      targetMac: state.recovery.targetMac,
      targetIp: state.recovery.targetIp,
      snapshotId: state.recovery.snapshotId,
      attempts: state.recovery.attempts,
      lastError: state.recovery.lastError,
      terminal: state.recovery.terminal
    }
  };
}

const login = await fetch(baseUrl + "/api/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password })
});
if (!login.ok) throw new Error("Autenticação recusada: HTTP " + login.status);
const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
const { csrf } = await login.json();
if (!cookie || !csrf) throw new Error("Sessão sem cookie ou token CSRF.");

async function request(pathname, options = {}) {
  const response = await fetch(baseUrl + pathname, {
    ...options,
    headers: {
      Cookie: cookie,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.method && options.method !== "GET" ? { "X-CSRF-Token": csrf } : {})
    }
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "HTTP " + response.status);
  return payload;
}

const before = await request("/api/state");
console.log(JSON.stringify({ phase: "before", ...operationalState(before) }, null, 2));
if (before.recovery && !before.recovery.terminal) throw new Error("Já existe uma recuperação ativa.");
if (!before.device?.online || !before.device?.adopted || before.device.defaultKey) {
  throw new Error("O switch tem de estar online, adotado e com chave própria.");
}

const reset = await request("/api/reset", {
  method: "POST",
  body: JSON.stringify({ mac: before.device.mac })
});
console.log(JSON.stringify({ phase: "reset-armed", snapshot: reset.snapshot, recovery: reset.recovery }, null, 2));

const started = Date.now();
let lastSignature = "";
while (Date.now() - started < timeoutMs) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const state = await request("/api/state");
  const current = operationalState(state);
  const signature = JSON.stringify(current.recovery);
  if (signature !== lastSignature || current.recovery?.terminal) {
    console.log(JSON.stringify({ phase: "recovery", elapsedMs: Date.now() - started, ...current }, null, 2));
    lastSignature = signature;
  }
  if (current.recovery?.terminal) {
    if (current.recovery.status !== "complete") process.exitCode = 1;
    break;
  }
}

const finalState = await request("/api/state");
console.log(JSON.stringify({ phase: "after", ...operationalState(finalState) }, null, 2));
if (finalState.recovery?.status !== "complete") process.exitCode = 1;
