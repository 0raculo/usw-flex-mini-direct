import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemConfig, configChanges, defaultSystemConfig, sanitizeDraft } from "../src/policy.mjs";

const ports = [
  { idx: 1, name: "Uplink", vlan: 1, mirrorSource: null, isUplink: true },
  { idx: 2, name: "Porta 2", vlan: 1, mirrorSource: null, isUplink: false },
  { idx: 3, name: "Porta 3", vlan: 200, mirrorSource: null, isUplink: false },
  { idx: 4, name: "Porta 4", vlan: 1, mirrorSource: null, isUplink: false },
  { idx: 5, name: "Porta 5", vlan: 1, mirrorSource: null, isUplink: false }
];

test("gera VLAN de acesso e mirroring no formato de configuração do switch", () => {
  const draft = sanitizeDraft({ ports: ports.map((port) => ({ ...port, vlan: port.idx === 4 ? 42 : port.vlan, mirrorSource: port.idx === 5 ? 1 : null })) }, ports);
  const text = buildSystemConfig(defaultSystemConfig(), draft);
  assert.match(text, /switch\.port\.4\.pvid=42/);
  assert.match(text, /switch\.port\.5\.opmode=mirror/);
  assert.match(text, /switch\.port\.5\.mirror_port=1/);
  assert.doesNotMatch(text, /switch\.port\.1\.pvid=/);
});

test("protege o uplink e cria uma alteração legível", () => {
  const before = { ports };
  assert.throws(() => sanitizeDraft({ ports: ports.map((port) => ({ ...port, vlan: port.isUplink ? 20 : port.vlan })) }, ports), /uplink/);
  const after = sanitizeDraft({ ports: ports.map((port) => ({ ...port, vlan: port.idx === 2 ? 20 : port.vlan })) }, ports);
  assert.match(configChanges(before, after)[0], /VLAN 1 → 20/);
});

test("rejeita VLAN inválida e mais de uma sessão de mirror", () => {
  assert.throws(() => sanitizeDraft({ ports: ports.map((port) => ({ ...port, vlan: port.idx === 2 ? 4095 : port.vlan })) }, ports), /4094/);
  assert.throws(() => sanitizeDraft({ ports: ports.map((port) => ({ ...port, mirrorSource: [4, 5].includes(port.idx) ? 2 : null })) }, ports), /uma porta/);
});
