import path from "node:path";

function bool(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function readConfig(env = process.env) {
  const port = Number(env.PORT || 8080);
  const publicUrl = String(env.INFORM_URL || `http://127.0.0.1:${port}/inform`).replace(/\/$/, "");
  const targets = String(env.DISCOVERY_TARGETS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    host: env.HOST || "0.0.0.0",
    port,
    dataDir: path.resolve(env.DATA_DIR || "./data"),
    adminPassword: env.ADMIN_PASSWORD || "",
    secret: env.SESSION_SECRET || "",
    informUrl: publicUrl,
    switchMac: String(env.SWITCH_MAC || "").trim().toLowerCase().replaceAll("-", ":"),
    bootstrapKeyFile: env.BOOTSTRAP_KEY_FILE || "",
    autoAdopt: bool(env.AUTO_ADOPT),
    discoveryEnabled: bool(env.DISCOVERY_ENABLED, targets.length > 0),
    discoveryTargets: targets,
    discoveryPort: Number(env.DISCOVERY_PORT || 10001),
    discoveryListenEnabled: bool(env.DISCOVERY_LISTEN_ENABLED, targets.length > 0),
    discoveryListenPort: Number(env.DISCOVERY_LISTEN_PORT || 10001),
    discoveryTimeoutMs: Math.max(100, Number(env.DISCOVERY_TIMEOUT_MS || 1400)),
    discoveryIntervalMs: Math.max(1000, Number(env.DISCOVERY_INTERVAL_MS || 30_000)),
    controllerChannelPort: Number(env.CONTROLLER_CHANNEL_PORT || 22),
    controllerChannelTimeoutMs: Math.max(250, Number(env.CONTROLLER_CHANNEL_TIMEOUT_MS || 5000)),
    recoveryIntervalMs: Math.max(50, Number(env.RECOVERY_INTERVAL_MS || 5000)),
    recoverySavedAddressDelayMs: Math.max(250, Number(env.RECOVERY_SAVED_ADDRESS_DELAY_MS || 12_000)),
    recoveryDarkTimeoutMs: Math.max(10_000, Number(env.RECOVERY_DARK_TIMEOUT_MS || 300_000)),
    sessionHours: Math.min(24, Math.max(1, Number(env.SESSION_HOURS || 12))),
    trustProxy: bool(env.TRUST_PROXY)
  };
}
