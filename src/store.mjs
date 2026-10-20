import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_KEY } from "./protocol.mjs";
import { configFromSystemConfig } from "./policy.mjs";

export class StateStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, "state.json");
    this.snapshotDir = path.join(dataDir, "snapshots");
    this.queue = Promise.resolve();
    this.state = {
      version: 1,
      device: null,
      config: null,
      baseline: null,
      pendingAdoption: null,
      pendingConfig: null,
      recovery: null,
      lastError: null
    };
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.snapshotDir, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8"));
      this.state = { ...this.state, ...saved };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.save();
    }
    return this.state;
  }

  async save() {
    const temp = `${this.file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await fs.rename(temp, this.file);
    await fs.chmod(this.file, 0o600).catch(() => {});
  }

  update(mutator) {
    this.queue = this.queue.then(async () => {
      const result = await mutator(this.state);
      await this.save();
      return result;
    });
    return this.queue;
  }

  async recordInform(payload, key, meta = {}) {
    const now = new Date().toISOString();
    return this.update((state) => {
      const previous = state.device || {};
      const mac = meta.mac || previous.mac;
      // During a mirroring apply the switch can omit port_table from an inform.
      // Keep the last telemetry snapshot instead of briefly exposing zero ports.
      const ports = Array.isArray(payload.port_table) && payload.port_table.length
        ? payload.port_table.map((port) => ({
            idx: Number(port.port_idx),
            up: Boolean(port.up),
            speed: Number(port.speed || 0),
            media: port.media || "",
            isUplink: Boolean(port.is_uplink)
          }))
        : previous.ports || [];
      const displayModel = payload.model_display && payload.model_display !== payload.model
        ? payload.model_display
        : previous.modelDisplay || "USW Flex Mini";
      const factoryRecovery = Boolean(meta.factoryReset && key === DEFAULT_KEY.toString("hex"));
      state.device = {
        ...previous,
        mac,
        serial: payload.serial || previous.serial || "",
        model: payload.model || previous.model || "USW Flex Mini",
        modelDisplay: displayModel === "USMINI" ? "USW Flex Mini" : displayModel,
        firmware: payload.version || previous.firmware || "",
        ip: payload.ip || previous.ip || "",
        hostname: payload.hostname || previous.hostname || "",
        uptime: Number(payload.uptime || 0),
        cfgversion: payload.cfgversion || previous.cfgversion || "",
        defaultKey: factoryRecovery || Boolean(payload.default || payload._default_key),
        ports,
        switchCaps: payload.switch_caps || previous.switchCaps || {},
        key: key || previous.key,
        lastSeen: now,
        informUrl: meta.informUrl || state.device?.informUrl || "",
        remote: meta.remote || previous.remote || ""
      };
      if (factoryRecovery) {
        state.device.adopted = false;
        state.device.originDefault = true;
        state.config = configFromSystemConfig(state.baseline, ports);
        state.pendingAdoption = null;
        state.pendingConfig = null;
        delete state.device.nextKey;
        delete state.device.wantAdoption;
        delete state.device.adoptionSentAt;
      } else if (!previous.mac) {
        state.device.adopted = false;
        state.device.originDefault = Boolean(payload.default || payload._default_key);
      }
      const inheritedKey = state.device.originDefault === undefined;
      if (inheritedKey) state.device.originDefault = false;
      if (!factoryRecovery && !state.device.originDefault && (!previous.mac || inheritedKey)) {
        // A device already carrying a controller key can be managed directly once
        // its informs reach this process; no key rotation is required for cutover.
        state.device.adopted = true;
        state.pendingAdoption = null;
        delete state.device.nextKey;
        delete state.device.wantAdoption;
      }
      if (!factoryRecovery && state.pendingAdoption && key === state.pendingAdoption.key) {
        state.device.key = key;
        state.device.adopted = true;
        delete state.device.nextKey;
        delete state.device.wantAdoption;
        state.pendingAdoption = null;
      } else if (!factoryRecovery && state.pendingAdoption) {
        state.device.nextKey = state.pendingAdoption.key;
        state.device.wantAdoption = true;
      } else if (!factoryRecovery && state.device.nextKey && key === state.device.nextKey) {
        state.device.key = key;
        state.device.adopted = true;
        delete state.device.nextKey;
        delete state.device.wantAdoption;
      }
      if (!state.config) {
        state.config = configFromSystemConfig(state.baseline, ports);
      }
      if (state.pendingConfig?.sent && payload.cfgversion === state.pendingConfig.cfgversion) {
        state.pendingConfig.appliedAt = now;
      }
      state.lastError = null;
    });
  }

  async saveSnapshot(reason = "manual") {
    const id = `${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${crypto.randomBytes(3).toString("hex")}`;
    const snapshot = {
      id,
      createdAt: new Date().toISOString(),
      reason,
      config: structuredClone(this.state.config),
      cfgversion: this.state.device?.cfgversion || ""
    };
    await fs.writeFile(path.join(this.snapshotDir, `${id}.json`), JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    return snapshot;
  }

  async listSnapshots() {
    const names = (await fs.readdir(this.snapshotDir)).filter((name) => /^[A-Za-z0-9._-]+\.json$/.test(name));
    const snapshots = [];
    for (const name of names) {
      try {
        const snapshot = JSON.parse(await fs.readFile(path.join(this.snapshotDir, name), "utf8"));
        snapshots.push({ id: snapshot.id, createdAt: snapshot.createdAt, reason: snapshot.reason, cfgversion: snapshot.cfgversion });
      } catch {}
    }
    return snapshots.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 20);
  }

  async readSnapshot(id) {
    if (!/^[A-Za-z0-9._-]+$/.test(String(id))) throw new Error("Snapshot inválido.");
    return JSON.parse(await fs.readFile(path.join(this.snapshotDir, `${id}.json`), "utf8"));
  }
}

export async function audit(dataDir, event) {
  await fs.appendFile(path.join(dataDir, "audit.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
}
