import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function ensureSecret(dataDir, supplied) {
  if (supplied && supplied.length >= 32) return Buffer.from(supplied);
  const file = path.join(dataDir, "session-secret");
  try {
    const value = await fs.readFile(file);
    if (value.length >= 32) return value;
  } catch {}
  const value = crypto.randomBytes(32);
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, value, { mode: 0o600 });
  return value;
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createSession(secret, hours) {
  const csrf = crypto.randomBytes(24).toString("base64url");
  const data = { iat: Date.now(), csrf };
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return { token: `${payload}.${signature}`, csrf, maxAge: hours * 3600 };
}

export function parseSession(token, secret, hours) {
  if (!token || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  if (!safeEqual(signature, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.iat || Date.now() - data.iat > hours * 3600_000) return null;
    return data;
  } catch {
    return null;
  }
}

export function cookieValue(header = "") {
  for (const pair of String(header).split(";")) {
    const [name, ...rest] = pair.trim().split("=");
    if (name === "ufmd_session") return decodeURIComponent(rest.join("="));
  }
  return "";
}
