import path from "node:path";

function bool(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function readConfig(env = process.env) {
  const port = Number(env.PORT || 8080);
  const publicUrl = String(env.INFORM_URL || `http://127.0.0.1:${port}/inform`).replace(/\/$/, "");
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
    sessionHours: Math.min(24, Math.max(1, Number(env.SESSION_HOURS || 12))),
    trustProxy: bool(env.TRUST_PROXY)
  };
}
