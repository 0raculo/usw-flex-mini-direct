import crypto from "node:crypto";

const IMAGE_MAGIC = 0xaa5555aa;
const COMPONENT_MAGIC = 0x11223344;
const SEGMENT_MAGIC = 0x01020304;
const COMPONENT_HEADER_SIZE = 24;
const SEGMENT_HEADER_SIZE = 12;
const COMPONENT_NAMES = new Map([
  [0x11, "app"],
  [0x12, "loader"],
  [0x15, "signature"]
]);

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[n] = value >>> 0;
}

export function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function assertRange(buffer, offset, length, label) {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error(`${label}: intervalo fora da imagem (${offset}+${length}, tamanho ${buffer.length}).`);
  }
}

function parseSegments(buffer, payloadOffset, payloadLength, footerLength) {
  const segments = [];
  const parts = [];
  let cursor = payloadOffset;
  const dataEnd = payloadOffset + payloadLength;
  while (cursor + SEGMENT_HEADER_SIZE <= dataEnd && buffer.readUInt32BE(cursor) === SEGMENT_MAGIC) {
    const expectedCrc = buffer.readUInt32BE(cursor + 4);
    const size = buffer.readUInt32BE(cursor + 8);
    assertRange(buffer, cursor + SEGMENT_HEADER_SIZE, size, "segmento");
    const dataStart = cursor + SEGMENT_HEADER_SIZE;
    if (dataStart + size > dataEnd) throw new Error("Segmento excede o payload do componente.");
    const data = buffer.subarray(dataStart, dataStart + size);
    const actualCrc = crc32(data);
    segments.push({ offset: cursor, dataOffset: dataStart, size, expectedCrc, actualCrc, crcValid: actualCrc === expectedCrc });
    parts.push(data);
    cursor = dataStart + size;
  }
  if (segments.length === 0) throw new Error("Componente segmentado sem segmentos reconhecíveis.");
  if (cursor + footerLength > dataEnd) throw new Error("Rodapé do componente incompleto.");
  return {
    segments,
    data: Buffer.concat(parts),
    footerOffset: cursor,
    footer: buffer.subarray(cursor, dataEnd)
  };
}

export function parseUsminiImage(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("A imagem tem de ser um Buffer.");
  assertRange(buffer, 0, 8, "cabeçalho exterior");
  if (buffer.readUInt32BE(0) !== IMAGE_MAGIC) throw new Error("Magic exterior USMINI inválido.");

  const components = [];
  let cursor = 8;
  while (cursor + COMPONENT_HEADER_SIZE <= buffer.length && buffer.readUInt32BE(cursor) === COMPONENT_MAGIC) {
    const type = buffer.readUInt16BE(cursor + 4);
    const product = buffer.readUInt16BE(cursor + 6);
    const flags = buffer.readUInt32BE(cursor + 8);
    const headerCrc = buffer.readUInt32BE(cursor + 12);
    const dataSize = buffer.readUInt32BE(cursor + 16);
    const payloadSize = buffer.readUInt32BE(cursor + 20);
    if (payloadSize < dataSize || payloadSize < 8) throw new Error(`Tamanhos inválidos no componente ${type.toString(16)}.`);
    const payloadOffset = cursor + COMPONENT_HEADER_SIZE;
    assertRange(buffer, payloadOffset, payloadSize, "payload do componente");
    const name = COMPONENT_NAMES.get(type) || `tipo-0x${type.toString(16)}`;
    const component = {
      offset: cursor,
      type,
      name,
      product,
      flags,
      headerCrc,
      dataSize,
      payloadSize,
      payloadOffset
    };

    if (type === 0x11 || type === 0x12) {
      const parsed = parseSegments(buffer, payloadOffset, payloadSize, 8);
      Object.assign(component, parsed, { data: parsed.data });
      delete component.footer;
    } else {
      const footerLength = payloadSize - dataSize;
      component.raw = buffer.subarray(payloadOffset, payloadOffset + dataSize);
      if (footerLength > 0) component.footer = buffer.subarray(payloadOffset + dataSize, payloadOffset + payloadSize);
    }
    component.sha256 = crypto.createHash("sha256").update(component.data || component.raw || Buffer.alloc(0)).digest("hex");
    components.push(component);
    cursor = payloadOffset + payloadSize;
  }

  const extensionMarker = buffer.indexOf(Buffer.from("usmini2"), cursor);
  return {
    protocol: buffer.subarray(4, 8).toString("hex"),
    size: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    components,
    recognizedBytes: cursor,
    trailing: {
      offset: cursor,
      size: buffer.length - cursor,
      platformMarker: extensionMarker >= 0 ? { name: "usmini2", offset: extensionMarker } : null
    },
    valid: components.length > 0 && components.every((component) => !component.segments || component.segments.every((segment) => segment.crcValid))
  };
}

export function publicFirmwareSummary(image) {
  return {
    protocol: image.protocol,
    size: image.size,
    sha256: image.sha256,
    valid: image.valid,
    recognizedBytes: image.recognizedBytes,
    trailing: image.trailing,
    components: image.components.map((component) => ({
      offset: component.offset,
      type: `0x${component.type.toString(16).padStart(4, "0")}`,
      name: component.name,
      product: component.product,
      flags: `0x${component.flags.toString(16).padStart(8, "0")}`,
      dataSize: component.dataSize,
      payloadSize: component.payloadSize,
      sha256: component.sha256,
      segments: component.segments?.map((segment) => ({
        offset: segment.offset,
        dataOffset: segment.dataOffset,
        size: segment.size,
        expectedCrc: `0x${segment.expectedCrc.toString(16).padStart(8, "0")}`,
        actualCrc: `0x${segment.actualCrc.toString(16).padStart(8, "0")}`,
        crcValid: segment.crcValid
      }))
    }))
  };
}
