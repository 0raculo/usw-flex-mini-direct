import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSession, cookieValue, ensureSecret, parseSession, safeEqual } from "./auth.mjs";
import { readConfig } from "./config.mjs";
import { sendControllerChannel } from "./controller-channel.mjs";
import { discoverDevices, listenForDevices } from "./discovery.mjs";
import { buildManagementConfig, buildSystemConfig, configChanges, configHash, defaultSystemConfig, sanitizeDraft } from "./policy.mjs";
import { decodePacket, DEFAULT_KEY, encodePacket, macFromPacket, newAuthKey, noopResponse, ProtocolError } from "./protocol.mjs";
import { audit, StateStore } from "./store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../public");
const config = readConfig();
if (config.adminPassword.length < 12) throw new Error("ADMIN_PASSWORD deve ter pelo menos 12 caracteres.");

const store = new StateStore(config.dataDir);
await store.init();
const secret = await ensureSecret(config.dataDir, config.secret);
const previews = new Map();
const failures = new Map();
const discoveredDevices = new Map();
const discoveryStatus = { lastScan: null, error: null, scanning: false, listening: false, listenError: null };
let discoveryRun = null;
let recoveryRun = Promise.resolve();
let lastPassiveTick = 0;

const recoveryTerminal = new Set(["complete", "failed"]);
const recoveryFactoryStates = new Set([
  "reset-sent",
  "waiting-factory",
  "channel-requested",
  "waiting-factory-inform",
  "adopting"
]);

async function loadBaseline() {
  try {
    const baseline = JSON.parse(await fs.readFile(path.join(config.dataDir, "baseline.json"), "utf8"));
    if (typeof baseline.systemCfg !== "string" || baseline.systemCfg.length < 20) throw new Error("baseline inválida");
    await store.update((state) => { state.baseline = baseline.systemCfg; });
    return "ficheiro importado";
  } catch (error) {
    if (error.code !== "ENOENT") console.error(`Baseline ignorada: ${error.message}`);
    if (!store.state.baseline) {
      const portCount = store.state.device?.ports?.length || 5;
      await store.update((state) => { state.baseline = defaultSystemConfig(portCount); });
    }
    return "modelo autónomo";
  }
}
const baselineSource = await loadBaseline();

async function loadBootstrapKey() {
  if (!config.bootstrapKeyFile) return null;
  try {
    return (await fs.readFile(config.bootstrapKeyFile, "utf8")).trim();
  } catch {
    return null;
  }
}
const bootstrapKey = await loadBootstrapKey();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png"
};

const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
};

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    ...securityHeaders,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(body);
}

async function body(req, limit = 256 * 1024, parse = true) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error("Pedido demasiado grande."), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  return parse && raw.length ? JSON.parse(raw.toString("utf8")) : raw;
}

function session(req) {
  return parseSession(cookieValue(req.headers.cookie), secret, config.sessionHours);
}

function requireSession(req, res) {
  const current = session(req);
  if (!current) json(res, 401, { error: "Autenticação necessária.", code: "AUTH_REQUIRED" });
  return current;
}

function csrf(req, res, current) {
  if (safeEqual(req.headers["x-csrf-token"] || "", current.csrf)) return true;
  json(res, 403, { error: "Token de proteção inválido. Recarregue a página.", code: "CSRF_INVALID" });
  return false;
}

function currentPorts() {
  const device = store.state.device;
  const settings = new Map((store.state.config?.ports || []).map((port) => [port.idx, port]));
  return (device?.ports || []).map((port) => ({
    ...port,
    ...(settings.get(port.idx) || { idx: port.idx, name: port.isUplink ? "Uplink" : `Porta ${port.idx}`, vlan: 1, mirrorSource: null })
  }));
}

function publicDiscovery() {
  const current = store.state.device;
  const devices = [...discoveredDevices.values()]
    .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
    .map((device) => {
      if (device.mac !== current?.mac) return device;
      return {
        ...device,
        ip: current.ip || device.ip,
        firmware: current.firmware || device.firmware,
        model: current.model || device.model,
        hostname: current.hostname || device.hostname,
        lastSeen: current.lastSeen || device.lastSeen,
        defaultKey: Boolean(current.defaultKey),
        managed: true
      };
    });
  if (current?.mac && !devices.some((device) => device.mac === current.mac)) {
    devices.push({
      mac: current.mac,
      ip: current.ip || "",
      firmware: current.firmware || "",
      model: current.model || "",
      hostname: current.hostname || "",
      defaultKey: Boolean(current.defaultKey),
      lastSeen: current.lastSeen,
      managed: true,
      known: true
    });
  }
  return {
    enabled: config.discoveryEnabled,
    targets: config.discoveryTargets,
    lastScan: discoveryStatus.lastScan,
    scanning: discoveryStatus.scanning,
    listening: discoveryStatus.listening,
    error: discoveryStatus.error,
    listenError: discoveryStatus.listenError,
    devices
  };
}

function rememberDiscovered(device) {
  const previous = discoveredDevices.get(device.mac);
  discoveredDevices.set(device.mac, {
    ...previous,
    ...device,
    ip: device.ip || previous?.ip || "",
    mac: device.mac,
    defaultKey: Boolean(device.defaultKey),
    lastSeen: device.lastSeen || new Date().toISOString()
  });
}

function publicRecovery() {
  const recovery = store.state.recovery;
  if (!recovery) return null;
  return {
    id: recovery.id,
    mode: recovery.mode,
    status: recovery.status,
    targetMac: recovery.targetMac,
    targetIp: recovery.targetIp,
    snapshotId: recovery.snapshotId || null,
    startedAt: recovery.startedAt,
    updatedAt: recovery.updatedAt,
    factorySeenAt: recovery.factorySeenAt || null,
    channelSentAt: recovery.channelSentAt || null,
    completedAt: recovery.completedAt || null,
    attempts: recovery.channelAttempts || 0,
    lastError: recovery.lastError || null,
    terminal: recoveryTerminal.has(recovery.status)
  };
}

async function updateRecovery(patch) {
  await store.update((state) => {
    if (!state.recovery) return;
    Object.assign(state.recovery, patch, { updatedAt: new Date().toISOString() });
  });
}

async function failRecovery(message) {
  await updateRecovery({ status: "failed", lastError: message });
  await audit(config.dataDir, { event: "recovery-failed", error: message });
}

async function queueSnapshotRestore(snapshotId) {
  const snapshot = await store.readSnapshot(snapshotId);
  const ports = currentPorts();
  const desired = sanitizeDraft({ ports: snapshot.config.ports }, ports);
  const version = configHash(desired);
  await store.update((state) => {
    state.config = desired;
    state.pendingConfig = {
      cfgversion: version,
      systemCfg: buildSystemConfig(state.baseline, desired),
      mgmtCfg: buildManagementConfig({ cfgversion: version, informUrl: config.informUrl }),
      changes: ["Reposição automática do snapshot anterior ao reset"],
      queuedAt: new Date().toISOString(),
      sent: false
    };
  });
  await audit(config.dataDir, { event: "recovery-snapshot-queued", snapshot: snapshotId, cfgversion: version });
  return version;
}

function factoryCandidate(recovery) {
  const cutoff = Date.now() - 60_000;
  return [...discoveredDevices.values()].find((device) => (
    device.mac === recovery.targetMac &&
    device.defaultKey &&
    device.ip &&
    device.lastSeen &&
    Date.parse(device.lastSeen) >= cutoff
  ));
}

async function requestRecoveryChannel(device) {
  const current = store.state.recovery;
  if (!current || recoveryTerminal.has(current.status)) return;
  const attempts = Number(current.channelAttempts || 0);
  if (attempts >= 6) {
    await failRecovery("O switch não aceitou o pedido de gestão depois de seis tentativas.");
    return;
  }
  await updateRecovery({
    status: "channel-requested",
    targetIp: device.ip,
    channelAttempts: attempts + 1,
    channelRequestedAt: new Date().toISOString(),
    lastError: null
  });
  try {
    await sendControllerChannel({
      host: device.ip,
      port: config.controllerChannelPort,
      mac: device.mac,
      informUrl: config.informUrl,
      timeoutMs: config.controllerChannelTimeoutMs
    });
    await updateRecovery({
      status: "waiting-factory-inform",
      channelSentAt: new Date().toISOString(),
      lastError: null
    });
    await audit(config.dataDir, { event: "recovery-channel-sent", mac: device.mac, ip: device.ip, attempt: attempts + 1 });
  } catch (error) {
    await updateRecovery({
      status: "waiting-factory",
      nextActionAt: new Date(Date.now() + Math.min(30_000, 2000 * 2 ** attempts)).toISOString(),
      lastError: error.message
    });
    await audit(config.dataDir, { event: "recovery-channel-failed", mac: device.mac, ip: device.ip, error: error.message });
  }
}

async function advanceRecovery() {
  const recovery = store.state.recovery;
  if (!recovery || recoveryTerminal.has(recovery.status)) return;
  const now = Date.now();

  if (recovery.status === "reset-sent" && now - Date.parse(recovery.resetSentAt || recovery.updatedAt) > config.recoveryDarkTimeoutMs) {
    await failRecovery("O switch não voltou a anunciar-se em estado de fábrica. A configuração anterior continua no snapshot.");
    return;
  }

  const candidate = factoryCandidate(recovery);
  if (candidate) {
    await updateRecovery({
      targetIp: candidate.ip,
      factorySeenAt: recovery.factorySeenAt || new Date().toISOString()
    });
    if (["reset-sent", "waiting-factory"].includes(recovery.status)) {
      await updateRecovery({ status: "waiting-factory" });
    }
  }

  const current = store.state.recovery;
  if (!current || recoveryTerminal.has(current.status)) return;
  const mayRequest = ["channel-requested", "waiting-factory"].includes(current.status) && candidate;
  const quietFor = now - Date.parse(current.channelSentAt || current.channelRequestedAt || current.updatedAt || 0);
  const retry = current.status === "waiting-factory-inform" && candidate && quietFor > 45_000;
  const readyAt = Date.parse(current.nextActionAt || 0);
  if ((mayRequest || retry) && (!current.nextActionAt || now >= readyAt)) {
    await requestRecoveryChannel(candidate);
  }

  const afterChannel = store.state.recovery;
  if (afterChannel?.status === "restoring" && store.state.pendingConfig?.appliedAt) {
    await updateRecovery({ status: "complete", completedAt: new Date().toISOString(), lastError: null });
    await audit(config.dataDir, { event: "recovery-complete", snapshot: afterChannel.snapshotId || null });
  }
}

function runRecoveryTick() {
  recoveryRun = recoveryRun
    .then(() => advanceRecovery())
    .catch((error) => {
      console.error(`Recuperação: ${error.message}`);
    });
  return recoveryRun;
}

async function scanForSwitches() {
  if (!config.discoveryEnabled) return [];
  if (discoveryRun) return discoveryRun;
  discoveryRun = (async () => {
    discoveryStatus.scanning = true;
    discoveryStatus.error = null;
    const targets = config.discoveryTargets.length
      ? config.discoveryTargets
      : store.state.device?.ip ? [store.state.device.ip] : [];
    try {
      const devices = await discoverDevices({
        targets,
        port: config.discoveryPort,
        timeoutMs: config.discoveryTimeoutMs
      });
      for (const device of devices) rememberDiscovered(device);
      discoveryStatus.lastScan = new Date().toISOString();
      await runRecoveryTick();
      return devices;
    } catch (error) {
      discoveryStatus.error = error.message;
      console.error(`Descoberta: ${error.message}`);
      return [];
    } finally {
      discoveryStatus.scanning = false;
      discoveryRun = null;
    }
  })();
  return discoveryRun;
}

function publicState() {
  const state = store.state;
  const device = state.device;
  const pending = state.pendingConfig;
  const seen = device?.lastSeen ? Date.now() - Date.parse(device.lastSeen) : Infinity;
  return {
    device: device ? {
      mac: device.mac,
      serial: device.serial,
      model: device.model,
      modelDisplay: device.modelDisplay,
      firmware: device.firmware,
      ip: device.ip,
      hostname: device.hostname,
      uptime: device.uptime,
      cfgversion: device.cfgversion,
      lastSeen: device.lastSeen,
      online: seen < 35_000,
      adopted: Boolean(device.adopted),
      defaultKey: Boolean(device.defaultKey),
      remote: device.remote,
      switchCaps: device.switchCaps || {}
    } : null,
    config: {
      ports: currentPorts().map(({ idx, name, vlan, mirrorSource, up, speed, media, isUplink }) => ({
        idx, name, vlan, mirrorSource, up, speed, media, isUplink
      }))
    },
    capabilities: {
      accessVlan: Number(device?.switchCaps?.vlan_caps || 0) >= 2,
      mirrorSessions: Number(device?.switchCaps?.max_mirror_sessions || 0),
      taggedVlan: false,
      stp: false,
      igmpSnooping: false
    },
    adoption: {
      pending: Boolean(state.pendingAdoption),
      informUrl: config.informUrl,
      baselineSource
    },
    discovery: publicDiscovery(),
    recovery: publicRecovery(),
    operation: pending ? {
      state: pending.appliedAt ? "applied" : pending.sent ? "waiting" : "queued",
      cfgversion: pending.cfgversion,
      queuedAt: pending.queuedAt,
      appliedAt: pending.appliedAt || null
    } : null,
    lastError: state.lastError
  };
}

async function login(req, res) {
  const remote = req.socket.remoteAddress || "unknown";
  const entry = failures.get(remote) || { count: 0, until: 0 };
  if (Date.now() < entry.until) {
    json(res, 429, { error: "Demasiadas tentativas. Aguarde alguns minutos.", code: "RATE_LIMITED" });
    return;
  }
  const input = await body(req);
  if (!safeEqual(input.password || "", config.adminPassword)) {
    entry.count += 1;
    if (entry.count >= 6) { entry.count = 0; entry.until = Date.now() + 5 * 60_000; }
    failures.set(remote, entry);
    json(res, 401, { error: "Palavra-passe incorreta.", code: "LOGIN_FAILED" });
    return;
  }
  failures.delete(remote);
  const created = createSession(secret, config.sessionHours);
  const secure = config.trustProxy && req.headers["x-forwarded-proto"] === "https";
  await audit(config.dataDir, { event: "login", remote });
  json(res, 200, { authenticated: true, csrf: created.csrf }, {
    "Set-Cookie": `ufmd_session=${created.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${created.maxAge}${secure ? "; Secure" : ""}`
  });
}

function describeError(error) {
  return error instanceof ProtocolError || error.status ? error.message : "Falha interna.";
}

async function api(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/login") return login(req, res);
  if (url.pathname === "/api/status") {
    const state = publicState();
    return json(res, 200, { device: state.device, authenticated: Boolean(session(req)) });
  }
  const current = requireSession(req, res);
  if (!current) return;
  if (req.method === "GET" && url.pathname === "/api/state") {
    return json(res, 200, { ...publicState(), csrf: current.csrf, snapshots: await store.listSnapshots() });
  }
  if (req.method === "GET" && url.pathname === "/api/session") return json(res, 200, { authenticated: true, csrf: current.csrf });

  if (req.method === "POST" && url.pathname === "/api/discovery") {
    if (!csrf(req, res, current)) return;
    if (!config.discoveryEnabled) return json(res, 409, { error: "A descoberta está desativada. Configure DISCOVERY_TARGETS e DISCOVERY_ENABLED.", code: "DISCOVERY_DISABLED" });
    await scanForSwitches();
    return json(res, 200, publicDiscovery());
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    if (!csrf(req, res, current)) return;
    const input = await body(req);
    const device = store.state.device;
    if (!device?.mac) return json(res, 409, { error: "Ainda não existe um switch conhecido para reiniciar.", code: "NO_DEVICE" });
    if (!device.adopted) return json(res, 409, { error: "O switch tem de estar adotado por esta aplicação antes do reset automático.", code: "NOT_ADOPTED" });
    if (Date.now() - Date.parse(device.lastSeen || 0) >= 35_000) return json(res, 409, { error: "O switch não está online. O reset exige um inform recente.", code: "DEVICE_OFFLINE" });
    const requestedMac = String(input.mac || "").trim().toLowerCase().replaceAll("-", ":");
    if (requestedMac && requestedMac !== device.mac) return json(res, 409, { error: "O MAC não coincide com o switch gerido.", code: "TARGET_MISMATCH" });
    if (store.state.recovery && !recoveryTerminal.has(store.state.recovery.status)) {
      return json(res, 409, { error: "Já existe uma recuperação em curso.", code: "RECOVERY_ACTIVE" });
    }
    if (!store.state.config?.ports?.length) return json(res, 409, { error: "Ainda não há uma configuração local para guardar.", code: "NO_CONFIG" });
    const snapshot = await store.saveSnapshot("before-factory-reset");
    const startedAt = new Date().toISOString();
    await store.update((state) => {
      state.pendingAdoption = null;
      state.pendingConfig = null;
      delete state.device.nextKey;
      delete state.device.wantAdoption;
      state.recovery = {
        id: crypto.randomBytes(8).toString("hex"),
        mode: "reset",
        status: "armed",
        targetMac: device.mac,
        targetIp: device.ip,
        snapshotId: snapshot.id,
        startedAt,
        updatedAt: startedAt,
        resetAttempts: 0,
        channelAttempts: 0
      };
    });
    await audit(config.dataDir, { event: "recovery-armed", mode: "reset", mac: device.mac, snapshot: snapshot.id });
    return json(res, 202, { accepted: true, snapshot: snapshot.id, recovery: publicRecovery() });
  }

  if (req.method === "POST" && url.pathname === "/api/preview") {
    if (!csrf(req, res, current)) return;
    if (store.state.recovery && !recoveryTerminal.has(store.state.recovery.status)) return json(res, 409, { error: "A recuperação do switch tem de terminar antes de alterar a configuração.", code: "RECOVERY_ACTIVE" });
    const input = await body(req);
    const ports = currentPorts();
    const desired = sanitizeDraft(input.draft, ports);
    const before = { ports: ports.map(({ idx, name, vlan, mirrorSource }) => ({ idx, name, vlan, mirrorSource })) };
    const changes = configChanges(before, desired);
    const token = crypto.randomBytes(24).toString("base64url");
    previews.set(token, { csrf: current.csrf, desired, changes, createdAt: Date.now() });
    for (const [key, value] of previews) if (Date.now() - value.createdAt > 10 * 60_000) previews.delete(key);
    return json(res, 200, { token, changes, empty: changes.length === 0 });
  }

  if (req.method === "POST" && url.pathname === "/api/apply") {
    if (!csrf(req, res, current)) return;
    if (store.state.recovery && !recoveryTerminal.has(store.state.recovery.status)) return json(res, 409, { error: "A recuperação do switch tem de terminar antes de alterar a configuração.", code: "RECOVERY_ACTIVE" });
    const input = await body(req);
    const preview = previews.get(input.token);
    if (!preview || preview.csrf !== current.csrf || Date.now() - preview.createdAt > 10 * 60_000) {
      return json(res, 409, { error: "A pré-visualização expirou.", code: "PREVIEW_EXPIRED" });
    }
    previews.delete(input.token);
    if (!preview.changes.length) return json(res, 409, { error: "Não há alterações para aplicar.", code: "NO_CHANGES" });
    const snapshot = await store.saveSnapshot("before-apply");
    const version = configHash(preview.desired);
    const systemCfg = buildSystemConfig(store.state.baseline, preview.desired);
    await store.update((state) => {
      state.config = preview.desired;
      state.pendingConfig = {
        cfgversion: version,
        systemCfg,
        mgmtCfg: buildManagementConfig({ cfgversion: version, informUrl: config.informUrl }),
        changes: preview.changes,
        queuedAt: new Date().toISOString(),
        sent: false
      };
    });
    await audit(config.dataDir, { event: "config-queued", snapshot: snapshot.id, changes: preview.changes });
    return json(res, 200, { queued: true, snapshot: snapshot.id, operation: publicState().operation });
  }

  if (req.method === "POST" && url.pathname === "/api/adopt") {
    if (!csrf(req, res, current)) return;
    const input = await body(req);
    const requestedMac = String(input.mac || "").trim().toLowerCase().replaceAll("-", ":");
    if (requestedMac || input.ip) {
      const target = discoveredDevices.get(requestedMac) || [...discoveredDevices.values()].find((device) => device.ip === input.ip);
      if (!target) return json(res, 409, { error: "O switch indicado já não consta dos resultados da última descoberta. Execute uma nova pesquisa.", code: "DISCOVERY_STALE" });
      if (!target.defaultKey) return json(res, 409, { error: "O switch descoberto não está em estado de fábrica; use o fluxo de reset e recuperação.", code: "NOT_FACTORY" });
      if (store.state.device?.mac && store.state.device.mac !== target.mac) return json(res, 409, { error: "A aplicação já está ligada a outro switch.", code: "OTHER_DEVICE" });
      if (store.state.recovery && !recoveryTerminal.has(store.state.recovery.status)) {
        return json(res, 409, { error: "Já existe uma recuperação em curso.", code: "RECOVERY_ACTIVE" });
      }
      const startedAt = new Date().toISOString();
      await store.update((state) => {
        state.recovery = {
          id: crypto.randomBytes(8).toString("hex"),
          mode: "adopt",
          status: "waiting-factory",
          targetMac: target.mac,
          targetIp: target.ip,
          startedAt,
          updatedAt: startedAt,
          factorySeenAt: target.lastSeen,
          channelAttempts: 0
        };
      });
      await audit(config.dataDir, { event: "recovery-armed", mode: "adopt", mac: target.mac, ip: target.ip });
      await requestRecoveryChannel(target);
      return json(res, 202, { accepted: true, informUrl: config.informUrl, recovery: publicRecovery() });
    }
    if (!store.state.device) return json(res, 409, { error: "O switch ainda não enviou um inform. Confirme o endereço e a ligação." });
    if (store.state.device.adopted) return json(res, 409, { error: "O switch já está adotado por esta aplicação.", code: "ALREADY_ADOPTED" });
    if (!store.state.device.defaultKey) {
      await store.update((state) => {
        state.device.adopted = true;
        state.pendingAdoption = null;
        delete state.device.nextKey;
      });
      await audit(config.dataDir, { event: "existing-key-assumed" });
      return json(res, 200, { assumed: true, informUrl: config.informUrl });
    }
    const key = newAuthKey();
    await store.update((state) => {
      state.pendingAdoption = { key, uri: config.informUrl, queuedAt: new Date().toISOString() };
    });
    await audit(config.dataDir, { event: "adoption-queued", informUrl: config.informUrl });
    return json(res, 200, { queued: true, informUrl: config.informUrl });
  }

  const restore = url.pathname.match(/^\/api\/snapshots\/([A-Za-z0-9._-]+)\/restore$/);
  if (req.method === "POST" && restore) {
    if (!csrf(req, res, current)) return;
    if (store.state.recovery && !recoveryTerminal.has(store.state.recovery.status)) return json(res, 409, { error: "A recuperação do switch tem de terminar antes de repor um snapshot.", code: "RECOVERY_ACTIVE" });
    const snapshot = await store.readSnapshot(restore[1]);
    const ports = currentPorts();
    const desired = sanitizeDraft({ ports: snapshot.config.ports }, ports);
    const before = { ports: ports.map(({ idx, name, vlan, mirrorSource }) => ({ idx, name, vlan, mirrorSource })) };
    const changes = configChanges(before, desired);
    const version = configHash(desired);
    await store.update((state) => {
      state.config = desired;
      state.pendingConfig = {
        cfgversion: version,
        systemCfg: buildSystemConfig(state.baseline, desired),
        mgmtCfg: buildManagementConfig({ cfgversion: version, informUrl: config.informUrl }),
        changes,
        queuedAt: new Date().toISOString(),
        sent: false
      };
    });
    await audit(config.dataDir, { event: "snapshot-restore", snapshot: snapshot.id, changes });
    return json(res, 200, { queued: true, changes, operation: publicState().operation });
  }

  return json(res, 404, { error: "Rota API desconhecida.", code: "NOT_FOUND" });
}

async function inform(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Método não permitido." }, { Allow: "POST" });
  let packet;
  try { packet = await body(req, 4 * 1024 * 1024, false); } catch (error) { return json(res, error.status || 400, { error: error.message }); }
  const headerMac = macFromPacket(packet);
  if (config.switchMac && headerMac !== config.switchMac) {
    return json(res, 403, { error: "MAC de switch não autorizado." });
  }
  const device = store.state.device;
  if (device?.mac && device.mac !== headerMac) return json(res, 403, { error: "Outro dispositivo tentou comunicar." });
  const recoveryBefore = store.state.recovery;
  const recoveryTarget = recoveryBefore?.targetMac === headerMac && recoveryFactoryStates.has(recoveryBefore.status);
  const candidates = [device?.key, device?.nextKey, bootstrapKey].filter(Boolean);
  if (recoveryTarget) candidates.push(DEFAULT_KEY.toString("hex"));
  if (!device?.key && !bootstrapKey) candidates.push(DEFAULT_KEY.toString("hex"));
  const uniqueCandidates = [...new Set(candidates)];
  let parsed;
  try {
    parsed = decodePacket(packet, uniqueCandidates);
  } catch (error) {
    await store.update((state) => { state.lastError = new Date().toISOString(); });
    console.error(`inform rejeitado de ${req.socket.remoteAddress}: ${error.message}`);
    return json(res, 400, { error: "Pacote inform não autenticado." });
  }
  if (parsed.mac !== headerMac) return json(res, 400, { error: "MAC inconsistente." });
  if (parsed.payload.mac && String(parsed.payload.mac).toLowerCase().replaceAll("-", ":") !== headerMac) {
    return json(res, 400, { error: "MAC do payload inconsistente." });
  }

  const factoryInform = Boolean(recoveryTarget && parsed.key.equals(DEFAULT_KEY));
  const initialFactoryInform = factoryInform && recoveryBefore.status !== "adopting";
  const adoptionBefore = store.state.pendingAdoption;

  await store.recordInform(parsed.payload, parsed.key.toString("hex"), {
    mac: headerMac,
    remote: req.socket.remoteAddress || "",
    informUrl: parsed.payload.inform_url || config.informUrl,
    factoryReset: initialFactoryInform
  });

  const adoptionConfirmed = Boolean(adoptionBefore && parsed.key.toString("hex") === adoptionBefore.key && store.state.device.adopted);
  let recoveryNow = store.state.recovery;
  let resetDue = false;
  if (recoveryNow?.mode === "reset" && recoveryNow.targetMac === headerMac && !factoryInform) {
    const resetAge = Date.now() - Date.parse(recoveryNow.resetSentAt || recoveryNow.updatedAt || 0);
    resetDue = recoveryNow.status === "armed" || (
      recoveryNow.status === "reset-sent" &&
      Number(recoveryNow.resetAttempts || 0) < 3 &&
      resetAge > 15_000
    );
  }

  if (factoryInform && recoveryNow && !store.state.pendingAdoption) {
    const key = newAuthKey();
    await store.update((state) => {
      state.pendingAdoption = { key, uri: config.informUrl, queuedAt: new Date().toISOString() };
      state.device.nextKey = key;
      state.device.adopted = false;
      if (state.recovery) {
        state.recovery.status = "adopting";
        state.recovery.factorySeenAt = state.recovery.factorySeenAt || new Date().toISOString();
        state.recovery.updatedAt = new Date().toISOString();
      }
    });
    await audit(config.dataDir, { event: "recovery-factory-inform", mac: headerMac });
  }

  recoveryNow = store.state.recovery;
  if (adoptionConfirmed && recoveryNow) {
    if (recoveryNow.mode === "reset" && recoveryNow.snapshotId) {
      await queueSnapshotRestore(recoveryNow.snapshotId);
      await updateRecovery({ status: "restoring", lastError: null });
    } else if (recoveryNow.mode === "adopt") {
      await updateRecovery({ status: "complete", completedAt: new Date().toISOString(), lastError: null });
      await audit(config.dataDir, { event: "recovery-complete", mode: "adopt" });
    }
  } else if (recoveryNow?.status === "restoring" && store.state.pendingConfig?.appliedAt) {
    await updateRecovery({ status: "complete", completedAt: new Date().toISOString(), lastError: null });
    await audit(config.dataDir, { event: "recovery-complete", snapshot: recoveryNow.snapshotId || null });
  }

  if (store.state.pendingConfig?.sent && !store.state.pendingConfig.appliedAt) {
    const age = Date.now() - Date.parse(store.state.pendingConfig.sentAt || store.state.pendingConfig.queuedAt);
    if (age > 20_000 && (store.state.pendingConfig.attempts || 1) < 4) {
      await store.update((state) => { state.pendingConfig.sent = false; });
    }
  }

  if (config.autoAdopt && !store.state.device.adopted && !store.state.pendingAdoption && !store.state.recovery) {
    await store.update((state) => {
      state.pendingAdoption = { key: newAuthKey(), uri: config.informUrl, queuedAt: new Date().toISOString() };
      state.device.nextKey = state.pendingAdoption.key;
    });
  }

  let reply;
  if (resetDue) {
    reply = { _type: "setdefault", server_time_in_utc: String(Date.now()) };
  } else if (store.state.pendingAdoption) {
    const adoption = store.state.pendingAdoption;
    reply = {
      _type: "setparam",
      cfgversion: "0123456789abcdef",
      mgmt_cfg: buildManagementConfig({ cfgversion: "0123456789abcdef", informUrl: adoption.uri, authKey: adoption.key }),
      server_time_in_utc: String(Date.now())
    };
    await store.update((state) => {
      state.device.nextKey = adoption.key;
      state.device.adoptionSentAt = new Date().toISOString();
    });
  } else if (store.state.pendingConfig && !store.state.pendingConfig.sent && !store.state.device.nextKey) {
    const pending = store.state.pendingConfig;
    reply = {
      _type: "setparam",
      cfgversion: pending.cfgversion,
      system_cfg: pending.systemCfg,
      mgmt_cfg: pending.mgmtCfg,
      server_time_in_utc: String(Date.now())
    };
    await store.update((state) => {
      state.pendingConfig.sent = true;
      state.pendingConfig.sentAt = new Date().toISOString();
      state.pendingConfig.attempts = (state.pendingConfig.attempts || 0) + 1;
    });
    await audit(config.dataDir, { event: "config-sent", cfgversion: pending.cfgversion });
  } else {
    reply = noopResponse();
  }

  const encoded = encodePacket(reply, parsed.key, { mac: headerMac, gcm: true });
  if (resetDue) {
    const attempts = Number(store.state.recovery?.resetAttempts || 0) + 1;
    await updateRecovery({
      status: "reset-sent",
      resetSentAt: new Date().toISOString(),
      resetAttempts: attempts,
      lastError: null
    });
    await audit(config.dataDir, { event: "recovery-setdefault-sent", mac: headerMac, attempt: attempts });
  }
  res.writeHead(200, { ...securityHeaders, "Content-Type": "application/x-binary", "Content-Length": encoded.length, "Cache-Control": "no-store" });
  res.end(encoded);
}

async function staticFile(req, res, url) {
  let file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (!/^[A-Za-z0-9._-]+$/.test(file)) return json(res, 404, { error: "Não encontrado." });
  try {
    const data = await fs.readFile(path.join(publicDir, file));
    const mutable = [".html", ".css", ".js"].includes(path.extname(file));
    res.writeHead(200, {
      ...securityHeaders,
      "Content-Type": contentTypes[path.extname(file)] || "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": mutable ? "no-cache" : "public, max-age=3600"
    });
    res.end(data);
  } catch {
    json(res, 404, { error: "Não encontrado." });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/inform") return await inform(req, res);
    if (url.pathname === "/api/health") return json(res, 200, { ok: true, direct: true, uptime: process.uptime() });
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Método não permitido." }, { Allow: "GET" });
    return await staticFile(req, res, url);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, error.status || 400, { error: describeError(error) });
    else res.end();
  }
});

server.listen(config.port, config.host, () => {
  console.log(`USW Flex Mini Direct em http://${config.host}:${config.port}`);
  console.log(`Inform URL: ${config.informUrl}`);
  console.log(`Descoberta: ${config.discoveryEnabled ? config.discoveryTargets.join(", ") || "IP conhecido" : "desativada"}`);
});

const discoveryTimer = config.discoveryEnabled
  ? setInterval(() => { scanForSwitches().catch(() => {}); }, config.discoveryIntervalMs)
  : null;
const recoveryTimer = setInterval(() => { runRecoveryTick(); }, config.recoveryIntervalMs);
let discoveryListener = null;
if (config.discoveryListenEnabled) {
  try {
    discoveryListener = await listenForDevices({
      port: config.discoveryListenPort,
      onDevice: (device) => {
        rememberDiscovered(device);
        if (Date.now() - lastPassiveTick > 1000) {
          lastPassiveTick = Date.now();
          runRecoveryTick();
        }
      },
      onError: (error) => {
        discoveryStatus.listenError = error.message;
        console.error("Recetor de descoberta: " + error.message);
      }
    });
    discoveryStatus.listening = true;
    console.log("Recetor de descoberta UDP: " + config.discoveryListenPort);
  } catch (error) {
    discoveryStatus.listenError = error.message;
    console.error("Recetor de descoberta indisponível: " + error.message);
  }
}
setTimeout(() => { scanForSwitches().catch(() => {}); }, 500).unref();
discoveryTimer?.unref();
recoveryTimer.unref();

function shutdown() {
  if (discoveryTimer) clearInterval(discoveryTimer);
  discoveryListener?.close();
  clearInterval(recoveryTimer);
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
