import assert from "node:assert/strict";
import test from "node:test";
import { crc32, parseUsminiImage, publicFirmwareSummary } from "../src/firmware-image.mjs";

function segment(data) {
  const header = Buffer.alloc(12);
  header.writeUInt32BE(0x01020304, 0);
  header.writeUInt32BE(crc32(data), 4);
  header.writeUInt32BE(data.length, 8);
  return Buffer.concat([header, data]);
}

function component(type, product, segments) {
  const payload = Buffer.concat([...segments, Buffer.alloc(8, 0xff)]);
  const header = Buffer.alloc(24);
  header.writeUInt32BE(0x11223344, 0);
  header.writeUInt16BE(type, 4);
  header.writeUInt16BE(product, 6);
  header.writeUInt32BE(0x01020304, 8);
  header.writeUInt32BE(Buffer.concat(segments).readUInt32BE(4), 12);
  header.writeUInt32BE(segments.reduce((total, item) => total + item.length - 12, 0), 16);
  header.writeUInt32BE(payload.length, 20);
  return Buffer.concat([header, payload]);
}

function image(...components) {
  const header = Buffer.from("aa5555aa00020000", "hex");
  const extension = Buffer.from("padding-usmini2-espressif", "ascii");
  return Buffer.concat([header, ...components, extension]);
}

test("extrai e valida componentes segmentados USMINI", () => {
  const loader = component(0x12, 0, [segment(Buffer.from("loader-a")), segment(Buffer.from("loader-b"))]);
  const app = component(0x11, 1, [segment(Buffer.from("application"))]);
  const parsed = parseUsminiImage(image(loader, app));
  assert.equal(parsed.valid, true);
  assert.equal(parsed.components.length, 2);
  assert.equal(parsed.components[0].data.toString(), "loader-aloader-b");
  assert.equal(parsed.components[1].data.toString(), "application");
  assert.equal(parsed.trailing.platformMarker.name, "usmini2");
  assert.equal(publicFirmwareSummary(parsed).components[1].segments[0].crcValid, true);
});

test("assinala segmentos cujo CRC não confere", () => {
  const item = segment(Buffer.from("firmware"));
  item[12] ^= 1;
  const parsed = parseUsminiImage(image(component(0x11, 1, [item])));
  assert.equal(parsed.valid, false);
  assert.equal(parsed.components[0].segments[0].crcValid, false);
});

test("rejeita uma imagem exterior que não é USMINI", () => {
  assert.throws(() => parseUsminiImage(Buffer.alloc(64)), /Magic exterior/);
});
