import crypto from "node:crypto";
import zlib from "node:zlib";

export const DEFAULT_KEY = crypto.createHash("md5").update("ubnt").digest();
export const MAGIC = Buffer.from("TNBU");

const FLAG_ENCRYPTED = 0x01;
const FLAG_ZLIB = 0x02;
const FLAG_SNAPPY = 0x04;
const FLAG_GCM = 0x08;

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function authKey(value) {
  if (Buffer.isBuffer(value) && value.length === 16) return Buffer.from(value);
  const text = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(text)) throw new ProtocolError("A chave de dispositivo deve ter 32 caracteres hexadecimais.");
  return Buffer.from(text, "hex");
}

export function newAuthKey() {
  return crypto.randomBytes(16).toString("hex");
}

export function macFromPacket(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 40 || !packet.subarray(0, 4).equals(MAGIC)) {
    throw new ProtocolError("Pacote inform inválido.");
  }
  return [...packet.subarray(8, 14)].map((byte) => byte.toString(16).padStart(2, "0")).join(":");
}

function unpad(buffer) {
  if (!buffer.length) throw new ProtocolError("Resposta CBC vazia.");
  const length = buffer[buffer.length - 1];
  if (length < 1 || length > 16 || length > buffer.length) throw new ProtocolError("Padding CBC inválido.");
  for (let index = buffer.length - length; index < buffer.length; index += 1) {
    if (buffer[index] !== length) throw new ProtocolError("Padding CBC inválido.");
  }
  return buffer.subarray(0, buffer.length - length);
}

export function decodePacket(packet, keys) {
  if (!Buffer.isBuffer(packet) || packet.length < 41 || !packet.subarray(0, 4).equals(MAGIC)) {
    throw new ProtocolError("Pacote inform inválido.");
  }
  const header = packet.subarray(0, 40);
  const flags = header.readUInt16BE(14);
  const bodyLength = header.readUInt32BE(36);
  const body = packet.subarray(40);
  if (body.length !== bodyLength) throw new ProtocolError("Tamanho do corpo não coincide com o cabeçalho.");
  if (!(flags & FLAG_ENCRYPTED)) throw new ProtocolError("O equipamento enviou um inform sem cifra.");
  if (flags & FLAG_SNAPPY) throw new ProtocolError("Compressão snappy não é suportada.");
  const iv = header.subarray(16, 32);
  const candidates = (Array.isArray(keys) ? keys : [keys]).filter(Boolean).map(authKey);
  let lastError;
  for (const key of candidates) {
    try {
      let plain;
      if (flags & FLAG_GCM) {
        if (body.length < 17) throw new ProtocolError("Corpo GCM demasiado curto.");
        const decipher = crypto.createDecipheriv("aes-128-gcm", key, iv);
        decipher.setAAD(header);
        decipher.setAuthTag(body.subarray(-16));
        plain = Buffer.concat([decipher.update(body.subarray(0, -16)), decipher.final()]);
      } else {
        const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
        decipher.setAutoPadding(false);
        plain = unpad(Buffer.concat([decipher.update(body), decipher.final()]));
      }
      if (flags & FLAG_ZLIB) plain = zlib.inflateSync(plain);
      const payload = JSON.parse(plain.toString("utf8"));
      return { payload, key, flags, mac: macFromPacket(packet), gcm: Boolean(flags & FLAG_GCM) };
    } catch (error) {
      lastError = error;
    }
  }
  throw new ProtocolError(`Não foi possível autenticar o inform${lastError ? `: ${lastError.message}` : "."}`);
}

export function encodePacket(payload, keyValue, { mac, gcm = true, compress = false } = {}) {
  const key = authKey(keyValue);
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const plain = compress ? zlib.deflateSync(json) : json;
  const iv = crypto.randomBytes(16);
  const header = Buffer.alloc(40);
  MAGIC.copy(header, 0);
  header.writeUInt32BE(0, 4);
  const macBytes = String(mac).split(":").map((part) => Number.parseInt(part, 16));
  if (macBytes.length !== 6 || macBytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new ProtocolError("Endereço MAC inválido.");
  }
  Buffer.from(macBytes).copy(header, 8);
  header.writeUInt16BE(FLAG_ENCRYPTED | (compress ? FLAG_ZLIB : 0) | (gcm ? FLAG_GCM : 0), 14);
  iv.copy(header, 16);
  header.writeUInt32BE(1, 32);

  let body;
  if (gcm) {
    header.writeUInt32BE(plain.length + 16, 36);
    const cipher = crypto.createCipheriv("aes-128-gcm", key, iv);
    cipher.setAAD(header);
    body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  } else {
    const padding = 16 - (plain.length % 16);
    header.writeUInt32BE(plain.length + padding, 36);
    const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
    body = Buffer.concat([cipher.update(plain), cipher.final()]);
  }
  return Buffer.concat([header, body]);
}

export function noopResponse() {
  return {
    _type: "noop",
    interval: 10,
    live_update: false,
    include_blocks: [],
    server_time_in_utc: String(Date.now())
  };
}
