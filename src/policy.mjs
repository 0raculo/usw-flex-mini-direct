const RESERVED_VLANS = new Set([0, 4095]);

function normalizedVlan(value) {
  const vlan = Number(value);
  if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094 || RESERVED_VLANS.has(vlan)) {
    throw new Error("A VLAN deve ser um número inteiro entre 1 e 4094.");
  }
  return vlan;
}

function validPort(value, ports) {
  const idx = Number(value);
  if (!Number.isInteger(idx) || !ports.some((port) => port.idx === idx)) throw new Error(`A porta ${value} não existe.`);
  return idx;
}

export function sanitizeDraft(draft, ports) {
  if (!draft || !Array.isArray(draft.ports)) throw new Error("Configuração de portas em falta.");
  const uplink = ports.find((port) => port.isUplink);
  const submitted = new Map(draft.ports.map((port) => [Number(port.idx), port]));
  const output = ports.map((port) => {
    const request = submitted.get(port.idx) || {};
    const result = {
      idx: port.idx,
      name: String(request.name || port.name || `Porta ${port.idx}`).trim().slice(0, 40),
      vlan: normalizedVlan(request.vlan ?? port.vlan ?? 1),
      mirrorSource: request.mirrorSource === null || request.mirrorSource === undefined || request.mirrorSource === ""
        ? null
        : validPort(request.mirrorSource, ports)
    };
    if (port.isUplink) {
      if (result.vlan !== port.vlan || result.mirrorSource !== null) {
        throw new Error("A porta de uplink está protegida contra alterações de VLAN e mirroring.");
      }
      result.name = port.name;
    }
    if (result.mirrorSource === port.idx) throw new Error(`A porta ${port.idx} não pode espelhar-se a si própria.`);
    return result;
  });
  const targets = output.filter((port) => port.mirrorSource !== null);
  if (targets.length > 1) throw new Error("O USW Flex Mini suporta apenas uma porta de destino por sessão de mirroring.");
  return { ports: output };
}

export function configChanges(before, after) {
  const changes = [];
  for (const next of after.ports) {
    const previous = before.ports.find((port) => port.idx === next.idx);
    if (!previous) continue;
    if (previous.name !== next.name) changes.push(`${next.idx}: nome “${previous.name}” → “${next.name}”`);
    if (previous.vlan !== next.vlan) changes.push(`${next.idx}: VLAN ${previous.vlan} → ${next.vlan}`);
    if (previous.mirrorSource !== next.mirrorSource) {
      changes.push(`${next.idx}: ${next.mirrorSource === null ? "deixa de fazer mirroring" : `passa a espelhar a porta ${next.mirrorSource}`}`);
    }
  }
  return changes;
}

export function configHash(config) {
  return requireHash(JSON.stringify(config));
}

function requireHash(value) {
  // A deterministic 64-bit-looking version keeps the wire value compact.
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function buildSystemConfig(base, config) {
  const lines = String(base || "").split(/\r?\n/).filter((line, index, all) => line || index < all.length - 1);
  const kept = [];
  for (const line of lines) {
    const match = line.match(/^switch\.port\.(\d+)\./);
    if (match && ["name", "opmode", "pvid", "mirror_port"].some((field) => line.startsWith(`switch.port.${match[1]}.${field}=`))) continue;
    kept.push(line);
  }
  while (kept.at(-1) === "") kept.pop();
  const portLines = [];
  for (const port of config.ports) {
    portLines.push(`switch.port.${port.idx}.name=${port.name.replace(/[\r\n]/g, " ")}`);
    portLines.push(`switch.port.${port.idx}.opmode=${port.mirrorSource === null ? "switch" : "mirror"}`);
    if (port.vlan !== 1) portLines.push(`switch.port.${port.idx}.pvid=${port.vlan}`);
    if (port.mirrorSource !== null) portLines.push(`switch.port.${port.idx}.mirror_port=${port.mirrorSource}`);
  }
  let insertAt = kept.findIndex((line) => line.trim() === "# ntpclient");
  if (insertAt < 0) insertAt = kept.length;
  kept.splice(insertAt, 0, ...portLines);
  return `${kept.join("\n")}\n`;
}

export function buildManagementConfig({ cfgversion, informUrl, authKey = "", ledEnabled = true }) {
  const lines = [
    "capability=notif,fastapply-bg,notif-assoc-stat",
    "selfrun_guest_mode=pass",
    `cfgversion=${cfgversion}`,
    `led_enabled=${ledEnabled ? "true" : "false"}`,
    `inform_url=${informUrl}`,
    "use_aes_gcm=true",
    "report_crash=true"
  ];
  if (authKey) lines.push(`authkey=${authKey}`);
  lines.push("");
  return lines.join("\n");
}

export function defaultSystemConfig(portCount = 5) {
  const lines = [
    "# standalone",
    "unifi.version=usw-flex-mini-direct",
    "unifi.idp=enabled",
    "unifi.mcip=239.254.127.63",
    "unifi.feature.always_send_crash_logs=enabled",
    "system.timezone=WET0WEST,M3.5.0/1,M10.5.0",
    "locale.timezone=WET0WEST,M3.5.0/1,M10.5.0",
    "users.status=disabled",
    "vlan.status=disabled",
    "bridge.status=disabled",
    "netconf.status=enabled",
    "netconf.1.status=enabled",
    "netconf.1.devname=eth0",
    "netconf.1.ip=0.0.0.0",
    "netconf.1.autoip.status=disabled",
    "netconf.1.promisc=enabled",
    "netconf.1.up=enabled",
    "dhcpc.status=enabled",
    "dhcpc.1.status=enabled",
    "dhcpc.1.devname=eth0",
    "route.status=enabled",
    "resolv.status=enabled",
    "resolv.nameserver.1.status=disabled",
    "resolv.nameserver.2.status=disabled",
    "switch.power_source.status=disabled",
    "switch.managementvlan=1",
    "switch.wevent.idp=enabled",
    "switch.wevent.mcip=239.254.127.63",
    "switch.jumboframes=disabled",
    "switch.mtu=9216",
    "switch.routing_enabled=false"
  ];
  for (let idx = 1; idx <= portCount; idx += 1) {
    lines.push(`switch.port.${idx}.name=${idx === 1 ? "Uplink" : `Porta ${idx}`}`);
    lines.push(`switch.port.${idx}.opmode=switch`);
  }
  lines.push(
    "ntpclient.status=enabled",
    "ntpclient.1.status=enabled",
    "ntpclient.1.server=0.ubnt.pool.ntp.org",
    "ntpclient.2.status=enabled",
    "ntpclient.2.server=1.ubnt.pool.ntp.org",
    "ntpclient.3.status=enabled",
    "ntpclient.3.server=2.ubnt.pool.ntp.org",
    "ntpclient.4.status=enabled",
    "ntpclient.4.server=3.ubnt.pool.ntp.org",
    "# misc",
    ""
  );
  return lines.join("\n");
}

export function configFromSystemConfig(base, ports) {
  const values = new Map();
  for (const line of String(base || "").split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) values.set(line.slice(0, index), line.slice(index + 1));
  }
  return {
    ports: ports.map((port) => {
      const name = values.get(`switch.port.${port.idx}.name`) || (port.isUplink ? "Uplink" : `Porta ${port.idx}`);
      const vlan = Math.min(4094, Math.max(1, Number(values.get(`switch.port.${port.idx}.pvid`) || 1)));
      const mirror = values.get(`switch.port.${port.idx}.opmode`) === "mirror"
        ? Number(values.get(`switch.port.${port.idx}.mirror_port`) || 0) || null
        : null;
      return { idx: port.idx, name, vlan, mirrorSource: port.isUplink ? null : mirror };
    })
  };
}
