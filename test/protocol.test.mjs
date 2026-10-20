import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_KEY, decodePacket, encodePacket, ProtocolError } from "../src/protocol.mjs";

const mac = "74:83:c2:0f:39:35";
const key = "ba86f2bbe107c7c57eb5f2690775c712";

test("codifica e descodifica um inform AES-GCM sem compressão", () => {
  const payload = { model: "USMINI", state: 1, port_table: [{ port_idx: 1, up: true }] };
  const packet = encodePacket(payload, key, { mac });
  assert.equal(packet.subarray(0, 4).toString(), "TNBU");
  const decoded = decodePacket(packet, key);
  assert.deepEqual(decoded.payload, payload);
  assert.equal(decoded.mac, mac);
  assert.equal(decoded.gcm, true);
});

test("aceita zlib quando o equipamento escolhe esse formato", () => {
  const payload = { model: "USMINI", state: 1 };
  const packet = encodePacket(payload, key, { mac, compress: true });
  assert.equal(packet.readUInt16BE(14) & 0x02, 0x02);
  assert.deepEqual(decodePacket(packet, key).payload, payload);
});

test("mantém compatibilidade com inform AES-CBC", () => {
  const payload = { model: "USMINI", state: 2 };
  const packet = encodePacket(payload, DEFAULT_KEY, { mac, gcm: false });
  const decoded = decodePacket(packet, ["00000000000000000000000000000000", DEFAULT_KEY]);
  assert.deepEqual(decoded.payload, payload);
  assert.equal(decoded.gcm, false);
});

test("rejeita um pacote alterado", () => {
  const packet = encodePacket({ hello: "switch" }, key, { mac });
  packet[packet.length - 2] ^= 0x01;
  assert.throws(() => decodePacket(packet, key), ProtocolError);
});

test("rejeita um corpo cujo tamanho não coincide", () => {
  const packet = encodePacket({ hello: "switch" }, key, { mac }).subarray(0, -1);
  assert.throws(() => decodePacket(packet, key), ProtocolError);
});
