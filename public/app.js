const $ = (selector) => document.querySelector(selector);
let csrf = "";
let state = null;
let draft = null;
let dirty = false;
let previewToken = null;
let neededAttention = false;

async function api(url, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  if (csrf && options.method && options.method !== "GET") headers["X-CSRF-Token"] = csrf;
  const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Pedido recusado (${response.status}).`);
  return data;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function emptyMessage(text) {
  return el("p", "muted", text);
}

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = "toast"; }, 4200);
}

// Desativa o botão enquanto a ação corre e repõe o texto original no fim.
async function busy(button, label, action) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try { await action(); } catch (error) { toast(error.message, true); }
  finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function ago(value) {
  if (!value) return "nunca";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 10) return "agora";
  if (seconds < 60) return `há ${seconds} s`;
  return `há ${Math.round(seconds / 60)} min`;
}

function showApp(visible) {
  $("#login-view").hidden = visible;
  $("#app-view").hidden = !visible;
}

function showLogin(device) {
  showApp(false);
  $("#login-dot").classList.toggle("up", Boolean(device?.online));
  $("#login-device").textContent = device
    ? `${device.modelDisplay || device.model} · ${device.ip} · ${device.online ? "ligado" : "sem contacto recente"}`
    : "Nenhum switch contactou esta aplicação";
}

function cloneDraft(source) {
  return {
    ports: source.ports.map((port) => ({
      idx: port.idx,
      name: port.name,
      vlan: Number(port.vlan),
      mirrorSource: port.mirrorSource,
      up: Boolean(port.up),
      speed: Number(port.speed || 0),
      media: port.media || "",
      isUplink: Boolean(port.isUplink)
    }))
  };
}

function renderPorts() {
  const list = $("#port-list");
  list.replaceChildren();
  if (!draft.ports.length) list.append(emptyMessage("O switch ainda não reportou as portas."));
  else {
    const head = el("div", "port-row head");
    head.append(el("span", "", "Porta"), el("span", "", "Nome"), el("span", "", "VLAN"), el("span", "port-status", "Ligação"));
    list.append(head);
  }
  for (const port of draft.ports) {
    const row = el("div", "port-row");
    const id = el("div", "port-id");
    id.append(el("span", `dot${port.up ? " up" : ""}`), String(port.idx).padStart(2, "0"));

    const name = el("input");
    name.value = port.name;
    name.maxLength = 40;
    name.disabled = port.isUplink;
    name.setAttribute("aria-label", `Nome da porta ${port.idx}`);
    name.addEventListener("input", () => { port.name = name.value; draftChanged(); });

    const vlan = el("input");
    Object.assign(vlan, { type: "number", min: "1", max: "4094", value: String(port.vlan), disabled: port.isUplink, title: "VLAN de acesso" });
    vlan.setAttribute("aria-label", `VLAN de acesso da porta ${port.idx}`);
    vlan.addEventListener("change", () => { port.vlan = Number(vlan.value); draftChanged(); });

    const status = port.isUplink ? "Uplink protegido" : port.up ? `${port.speed} Mbps` : "Sem ligação";
    row.append(id, name, vlan, el("span", `port-status${port.isUplink ? " uplink" : ""}`, status));
    list.append(row);
  }
  renderMirror();
}

function renderMirror() {
  const source = $("#mirror-source");
  const target = $("#mirror-target");
  const active = draft.ports.find((port) => port.mirrorSource !== null);
  source.replaceChildren();
  target.replaceChildren(new Option("Desativado", ""));
  $(".mirror").hidden = !draft.ports.length;
  if (!draft.ports.length) return;
  for (const port of draft.ports) {
    source.append(new Option(`Porta ${port.idx}${port.isUplink ? " (uplink)" : ""}`, String(port.idx)));
    if (!port.isUplink) target.append(new Option(`Porta ${port.idx}`, String(port.idx)));
  }
  target.value = active ? String(active.idx) : "";
  source.value = String(active?.mirrorSource ?? draft.ports[0].idx);
  source.disabled = !active;
}

function renderDiscovery() {
  const discovery = state.discovery;
  const list = $("#discovery-list");
  const meta = $("#discovery-meta");
  const activeRecovery = state.recovery && !state.recovery.terminal;
  list.replaceChildren();
  $("#discovery-button").hidden = !discovery.enabled;
  if (!discovery.enabled) {
    meta.textContent = "Desativada";
    list.append(emptyMessage("Ative DISCOVERY_ENABLED e DISCOVERY_TARGETS para pesquisar. Sem descoberta, use o IP e o MAC abaixo."));
    return;
  }
  if (discovery.scanning) meta.textContent = "A pesquisar…";
  else if (discovery.error) meta.textContent = discovery.error;
  else {
    const when = discovery.lastScan ? new Date(discovery.lastScan).toLocaleTimeString("pt-PT") : "ainda não concluída";
    meta.textContent = `${discovery.devices.length} resultado${discovery.devices.length === 1 ? "" : "s"} · ${when}`;
  }
  if (!discovery.devices.length) {
    list.append(emptyMessage("Nenhum switch respondeu. Confirme DISCOVERY_TARGETS e a rede entre a aplicação e o equipamento."));
    return;
  }
  for (const device of discovery.devices) {
    const row = el("div", "discovered-device");
    const identity = el("div");
    identity.append(
      el("strong", "", device.model || device.platform || "Dispositivo Ubiquiti"),
      el("small", "", `${device.ip || "IP desconhecido"} · ${device.mac} · ${device.firmware || "firmware desconhecido"}`)
    );
    const label = device.defaultKey ? "Estado de fábrica" : device.managed ? "Gerido aqui" : "Gerido noutro controlador";
    row.append(identity, el("span", `tag${device.defaultKey ? " factory" : ""}`, label));
    if (device.defaultKey && !activeRecovery) {
      const button = el("button", "button", "Adotar");
      button.type = "button";
      button.addEventListener("click", () => busy(button, "A adotar…", () => adoptAddress(device.ip, device.mac)));
      row.append(button);
    }
    list.append(row);
  }
}

const recoveryDescriptions = {
  armed: ["Reset preparado", "O snapshot está guardado. O pedido segue no próximo inform, em poucos segundos."],
  "reset-sent": ["Reset enviado", "O switch está a reiniciar e vai voltar em estado de fábrica."],
  "waiting-factory": ["À procura do switch", "A aplicação tenta o último IP guardado. Se o IP mudou, indique-o em Adoção e recuperação."],
  "channel-requested": ["A abrir canal", "A aplicação está a entregar o URL de gestão ao firmware de fábrica."],
  "waiting-factory-inform": ["À espera da adoção", "O canal foi aberto. Falta o primeiro inform autenticado com a chave de fábrica."],
  adopting: ["A adotar", "Foi preparada uma chave própria e o switch está a confirmar a nova configuração de gestão."],
  restoring: ["A repor configuração", "A adoção foi confirmada. O snapshot anterior está a ser enviado e validado."],
  complete: ["Recuperação concluída", "O switch voltou a ser gerido pela aplicação e a configuração anterior foi confirmada."],
  failed: ["Recuperação interrompida", "O snapshot continua guardado. Veja o erro e tente novamente quando o switch voltar a comunicar."]
};

function renderRecovery() {
  const recovery = state.recovery;
  const panel = $("#recovery-panel");
  panel.hidden = !recovery;
  if (!recovery) return;
  const [title, detail] = recoveryDescriptions[recovery.status] || [recovery.status, "A aplicação continua a acompanhar o switch."];
  $("#recovery-title").textContent = title;
  $("#recovery-detail").textContent = detail;
  $("#recovery-error").hidden = !recovery.lastError;
  $("#recovery-error").textContent = recovery.lastError || "";
  const order = ["armed", "waiting-factory", "waiting-factory-inform", "adopting", "restoring", "complete"];
  const aliases = { "reset-sent": "armed", "channel-requested": "waiting-factory-inform" };
  const current = aliases[recovery.status] || recovery.status;
  const currentIndex = order.indexOf(current);
  const complete = recovery.status === "complete";
  for (const step of $("#recovery-steps").children) {
    const stepIndex = order.indexOf(step.dataset.step);
    step.classList.toggle("skipped", step.dataset.step === "restoring" && recovery.mode === "adopt");
    step.classList.toggle("done", complete || (currentIndex >= 0 && stepIndex < currentIndex));
    step.classList.toggle("current", !complete && step.dataset.step === current);
  }
}

function renderMaintenance() {
  const device = state.device;
  const activeRecovery = Boolean(state.recovery && !state.recovery.terminal);
  $("#reset-panel").hidden = !device?.adopted || !device.online || activeRecovery;
  // Abre a secção sozinha só quando passa a precisar de atenção; depois respeita o utilizador.
  const attention = !device?.adopted || activeRecovery;
  if (attention && !neededAttention) $("#maintenance").open = true;
  neededAttention = attention;
  $("#maintenance-meta").textContent = activeRecovery ? "Recuperação em curso"
    : !device ? "Nenhum switch ligado"
    : !device.adopted ? "Switch por adotar"
    : "Descoberta, adoção por IP e reset";
}

const operationLabels = { queued: "Em fila", waiting: "À espera do switch", applied: "Confirmada" };

function renderState() {
  if (!state) return;
  const device = state.device;
  const online = Boolean(device?.online);
  const pill = $("#connection-pill");
  pill.classList.toggle("offline", !online);
  pill.lastElementChild.textContent = device ? online ? "Ligado" : "Sem contacto" : "À espera";
  $("#device-title").textContent = device?.modelDisplay || device?.model || "USW Flex Mini";
  $("#device-subtitle").textContent = device
    ? `${device.hostname || "switch"} · ${device.mac}`
    : "O switch ainda não enviou um inform para esta aplicação.";
  $("#fact-state").textContent = device ? `${online ? "Online" : "Offline"} · ${ago(device.lastSeen)}` : "Pendente";
  $("#fact-ip").textContent = device?.ip || "—";
  $("#fact-firmware").textContent = device?.firmware || "—";
  $("#fact-config").textContent = operationLabels[state.operation?.state] || "Sem pendentes";
  $("#adoption-panel").hidden = !device || device.adopted;
  $("#adopt-url").textContent = state.adoption.informUrl;
  // Enquanto há edições por aplicar, não se redesenham as portas para não perder o foco nem o rascunho.
  if (!dirty) renderPorts();
  renderRecovery();
  renderSnapshots();
  renderDiscovery();
  renderMaintenance();
  $("#action-bar").hidden = !dirty;
}

const snapshotReasons = { "before-apply": "Antes de aplicar", "before-factory-reset": "Antes do reset", manual: "Manual" };

function renderSnapshots() {
  const list = $("#snapshot-list");
  list.replaceChildren();
  if (!state.snapshots.length) list.append(emptyMessage("Ainda não existem snapshots."));
  for (const snapshot of state.snapshots.slice(0, 6)) {
    const row = el("div", "snapshot");
    const text = el("div");
    text.append(
      el("span", "", new Date(snapshot.createdAt).toLocaleString("pt-PT")),
      el("small", "", snapshotReasons[snapshot.reason] || snapshot.reason)
    );
    const button = el("button", "button quiet", "Restaurar");
    button.type = "button";
    button.addEventListener("click", () => restore(snapshot));
    row.append(text, button);
    list.append(row);
  }
}

function draftChanged() {
  dirty = true;
  $("#action-bar").hidden = false;
  $("#review-panel").hidden = true;
}

function discardDraft() {
  draft = cloneDraft(state.config);
  dirty = false;
  $("#review-panel").hidden = true;
  renderState();
}

async function refresh({ quiet = false } = {}) {
  try {
    state = await api("/api/state");
    csrf = state.csrf;
    if (!dirty || !draft) draft = cloneDraft(state.config);
    renderState();
  } catch (error) {
    if (!quiet) toast(error.message, true);
    const status = await fetch("/api/status").then((response) => response.json()).catch(() => ({}));
    showLogin(status.device);
  }
}

async function preview() {
  const result = await api("/api/preview", { method: "POST", body: JSON.stringify({ draft }) });
  previewToken = result.token;
  $("#change-list").replaceChildren(...result.changes.map((change) => el("li", "", change)));
  $("#review-panel").hidden = false;
  $("#review-panel").scrollIntoView({ behavior: "smooth", block: "center" });
}

async function apply() {
  if (!previewToken) return;
  await api("/api/apply", { method: "POST", body: JSON.stringify({ token: previewToken }) });
  previewToken = null;
  dirty = false;
  $("#review-panel").hidden = true;
  toast("Configuração em fila. O switch confirma no próximo inform.");
  await refresh();
}

async function adopt() {
  const result = await api("/api/adopt", { method: "POST", body: "{}" });
  toast(`Adoção em fila para ${result.informUrl}.`);
  await refresh();
}

async function adoptAddress(ip, mac) {
  await api("/api/adopt", { method: "POST", body: JSON.stringify({ ip, mac }) });
  toast("Canal de adoção enviado. A aplicação acompanha o switch automaticamente.");
  await refresh();
}

async function scanNow() {
  await api("/api/discovery", { method: "POST", body: "{}" });
  await refresh();
}

async function resetAndRecover() {
  if (!confirm("Fazer reset de fábrica ao switch? É guardado um snapshot e a aplicação tenta readotá-lo e repor a configuração.")) return;
  const result = await api("/api/reset", { method: "POST", body: JSON.stringify({ mac: state.device.mac }) });
  toast(`Snapshot ${result.snapshot} guardado. O reset segue no próximo inform.`);
  await refresh();
}

async function restore(snapshot) {
  if (!confirm(`Repor no switch a configuração de ${new Date(snapshot.createdAt).toLocaleString("pt-PT")}?`)) return;
  try {
    await api(`/api/snapshots/${encodeURIComponent(snapshot.id)}/restore`, { method: "POST", body: "{}" });
    dirty = false;
    toast("Configuração anterior colocada em fila.");
    await refresh();
  } catch (error) { toast(error.message, true); }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#login-error").textContent = "";
  try {
    const result = await api("/api/login", { method: "POST", body: JSON.stringify({ password: $("#password").value }) });
    csrf = result.csrf;
    showApp(true);
    await refresh();
  } catch (error) { $("#login-error").textContent = error.message; }
});
$("#refresh-button").addEventListener("click", () => refresh());
$("#discovery-button").addEventListener("click", (event) => busy(event.currentTarget, "A pesquisar…", scanNow));
$("#manual-adopt-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const ip = $("#manual-adopt-ip").value.trim();
  const mac = $("#manual-adopt-mac").value.trim();
  busy(event.currentTarget.querySelector("button"), "A abrir canal…", () => adoptAddress(ip, mac));
});
$("#reset-button").addEventListener("click", (event) => busy(event.currentTarget, "A preparar…", resetAndRecover));
$("#adopt-button").addEventListener("click", (event) => busy(event.currentTarget, "A adotar…", adopt));
$("#preview-button").addEventListener("click", (event) => busy(event.currentTarget, "A preparar…", preview));
$("#apply-button").addEventListener("click", (event) => busy(event.currentTarget, "A enviar…", apply));
$("#close-review").addEventListener("click", () => { $("#review-panel").hidden = true; });
$("#discard-button").addEventListener("click", discardDraft);
$("#mirror-target").addEventListener("change", (event) => {
  for (const port of draft.ports) port.mirrorSource = null;
  const target = Number(event.target.value);
  if (target) draft.ports.find((port) => port.idx === target).mirrorSource = Number($("#mirror-source").value);
  draftChanged();
  renderMirror();
});
$("#mirror-source").addEventListener("change", () => {
  const active = draft.ports.find((port) => port.mirrorSource !== null);
  if (active) active.mirrorSource = Number($("#mirror-source").value);
  draftChanged();
});

const initial = await fetch("/api/status").then((response) => response.json()).catch(() => ({}));
if (initial.authenticated) {
  showApp(true);
  await refresh();
} else showLogin(initial.device);
setInterval(() => { if (!$("#app-view").hidden) refresh({ quiet: true }); }, 10_000);
