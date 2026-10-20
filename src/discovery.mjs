import dgram from "node:dgram";
import net from "node:net";

export const DISCOVERY_PORT = 10001;
export const V1_QUERY = Buffer.from([0x01, 0x00, 0x00, 0x00]);
export const V2_QUERY = Buffer.from([0x02, 0x08, 0x00, 0x00]);

const TLV_MAC = 0x01;
const TLV_IP = 0x02;
const TLV_FIRMWARE = 0x03;
const TLV_UPTIME = 0x0a;
const TLV_HOSTNAME = 0x0b;
const TLV_PLATFORM = 0x0c;
const TLV_MODEL_V1 = 0x14;
const TLV_MODEL = 0x15;
const TLV_SHORT_VERSION = 0x16;
const TLV_FACTORY = 0x17;
const TLV_DEVICE_ID = 0x20;

function mac(value) {
  if (!Buffer.isBuffer(value) || value.length !== 6) return "";
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join(":");
}

function text(value) {
  return value.toString("utf8").replaceAll("\u0000", "").trim();
}

export function parseDiscoveryPacket(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 4) return null;
  const version = packet[0];
  const command = packet[1];
  const payloadLength = packet.readUInt16BE(2);
  if (![1, 2].includes(version) || payloadLength > packet.length - 4) return null;

  const info = {
    version,
    command,
    mac: "",
    ip: "",
    firmware: "",
    shortVersion: "",
    hostname: "",
    platform: "",
    model: "",
    deviceId: "",
    uptime: 0,
    defaultKey: false
  };
  const end = 4 + payloadLength;
  let offset = 4;
  while (offset + 3 <= end) {
    const type = packet[offset];
    const length = packet.readUInt16BE(offset + 1);
    offset += 3;
    if (offset + length > end) return null;
    const value = packet.subarray(offset, offset + length);
    offset += length;
    switch (type) {
      case TLV_MAC:
        if (value.length === 6) info.mac = mac(value);
        break;
      case TLV_IP:
        if (value.length === 10) {
          info.mac ||= mac(value.subarray(0, 6));
          info.ip ||= [...value.subarray(6, 10)].join(".");
        }
        break;
      case TLV_FIRMWARE:
        info.firmware = text(value);
        break;
      case TLV_UPTIME:
        if (value.length >= 4) info.uptime = value.readUInt32BE(0);
        break;
      case TLV_HOSTNAME:
        info.hostname = text(value);
        break;
      case TLV_PLATFORM:
        info.platform = text(value);
        break;
      case TLV_MODEL_V1:
      case TLV_MODEL:
        info.model = text(value);
        break;
      case TLV_SHORT_VERSION:
        info.shortVersion = text(value);
        break;
      case TLV_FACTORY:
        info.defaultKey = value.length > 0 && value[0] === 1;
        break;
      case TLV_DEVICE_ID:
        info.deviceId = text(value);
        break;
      default:
        break;
    }
  }
  info.firmware ||= info.shortVersion;
  info.model ||= info.platform;
  return info.mac ? info : null;
}

function ipv4ToNumber(address) {
  const octets = String(address).split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return octets.reduce((result, value) => ((result << 8) | value) >>> 0, 0);
}

function numberToIpv4(value) {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");
}

export function expandTargets(values, { maxHosts = 4096, includeNetworkAndBroadcast = false } = {}) {
  const targets = new Set();
  for (const raw of values || []) {
    const value = String(raw).trim();
    if (!value) continue;
    const [address, prefixText] = value.split("/");
    const ip = ipv4ToNumber(address);
    if (ip === null) throw new Error(`Destino de descoberta inválido: ${value}`);
    if (prefixText === undefined) {
      targets.add(address);
      continue;
    }
    const prefix = Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error(`Prefixo CIDR inválido: ${value}`);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const network = (ip & mask) >>> 0;
    const broadcast = (network | (~mask >>> 0)) >>> 0;
    const start = includeNetworkAndBroadcast || prefix >= 31 ? network : network + 1;
    const end = includeNetworkAndBroadcast || prefix >= 31 ? broadcast : broadcast - 1;
    if (end - start + 1 > maxHosts) throw new Error(`O intervalo ${value} excede ${maxHosts} endereços.`);
    for (let current = start; current <= end; current += 1) targets.add(numberToIpv4(current));
  }
  return [...targets];
}

export async function discoverDevices({
  targets,
  port = DISCOVERY_PORT,
  timeoutMs = 1400,
  signal,
  onDevice = () => {}
} = {}) {
  const addresses = expandTargets(targets);
  if (!addresses.length) return [];
  const devices = new Map();
  const socket = dgram.createSocket("udp4");
  let settled = false;

  const receive = (packet, remote) => {
    const info = parseDiscoveryPacket(packet);
    if (!info) return;
    const previous = devices.get(info.mac);
    const merged = {
      ...previous,
      ...Object.fromEntries(Object.entries(info).filter(([, value]) => value !== "" && value !== 0 && value !== false)),
      mac: info.mac,
      ip: info.ip || previous?.ip || remote.address,
      defaultKey: info.defaultKey || Boolean(previous?.defaultKey),
      lastSeen: new Date().toISOString(),
      source: remote.address
    };
    devices.set(info.mac, merged);
    onDevice(merged);
  };

  const send = (address, packet) => new Promise((resolve) => {
    socket.send(packet, port, address, () => resolve());
  });

  try {
    await new Promise((resolve) => socket.bind(0, "0.0.0.0", resolve));
    socket.on("message", receive);
    socket.on("error", () => {});
    for (const address of addresses) {
      if (signal?.aborted) break;
      await Promise.all([send(address, V1_QUERY), send(address, V2_QUERY)]);
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    settled = true;
    return [...devices.values()].sort((a, b) => a.mac.localeCompare(b.mac));
  } finally {
    if (!settled) {
      try { socket.close(); } catch {}
    } else {
      try { socket.close(); } catch {}
    }
  }
}

export async function listenForDevices({ port = DISCOVERY_PORT, onDevice = () => {}, onError = () => {} } = {}) {
  const socket = dgram.createSocket("udp4");
  socket.on("message", (packet, remote) => {
    const info = parseDiscoveryPacket(packet);
    if (!info) return;
    onDevice({
      ...info,
      ip: info.ip || remote.address,
      lastSeen: new Date().toISOString(),
      source: remote.address,
      passive: true
    });
  });
  socket.on("error", onError);
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, "0.0.0.0", () => {
      socket.off("error", reject);
      resolve();
    });
  });
  return socket;
}

export function isIPv4(value) {
  return net.isIPv4(String(value || ""));
}
