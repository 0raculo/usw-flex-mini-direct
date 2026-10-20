const $ = (selector) => document.querySelector(selector);
let csrf = "";
let state = null;
let draft = null;
let dirty = false;
let previewToken = null;

async function api(url, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  if (csrf && options.method && options.method !== "GET") headers["X-CSRF-Token"] = csrf;
  const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Pedido recusado (${response.status}).`);
  return data;
}

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = "toast"; }, 4200);
}

function ago(value) {
  if (!value) return "Nunca";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 10) return "Agora";
  if (seconds < 60) return `Há ${seconds} s`;
  return `Há ${Math.round(seconds / 60)} min`;
}

function showLogin(device) {
  $("#login-view").hidden = false;
  $("#app-view").hidden = true;
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
  for (const port of draft.ports) {
    const row = document.createElement("div");
    row.className = "port-row";
    const id = document.createElement("div");
    id.className = "port-id";
    const led = document.createElement("i");
    if (port.up) led.className = "up";
    id.append(led, document.createTextNode(String(port.idx).padStart(2, "0")));

    const name = document.createElement("input");
    name.value = port.name;
    name.maxLength = 40;
    name.disabled = port.isUplink;
    name.setAttribute("aria-label", `Nome da porta ${port.idx}`);
    name.addEventListener("input", () => { port.name = name.value; draftChanged(); });

    const vlanWrap = document.createElement("label");
    vlanWrap.className = "vlan-input";
    const vlanLabel = document.createElement("span");
    vlanLabel.textContent = "VLAN";
    const vlan = document.createElement("input");
    vlan.type = "number";
    vlan.min = "1";
    vlan.max = "4094";
    vlan.value = String(port.vlan);
    vlan.disabled = port.isUplink;
    vlan.setAttribute("aria-label", `VLAN de acesso da porta ${port.idx}`);
    vlan.addEventListener("change", () => { port.vlan = Number(vlan.value); draftChanged(); });
    vlanWrap.append(vlanLabel, vlan);

    const status = document.createElement("span");
    status.className = port.isUplink ? "uplink-note" : "port-link";
    status.textContent = port.isUplink ? "Uplink protegido" : port.up ? `${port.speed} Mbps` : "Sem ligação";
    row.append(id, name, vlanWrap, status);
    list.append(row);
  }
  renderMirror();
}

function renderMirror() {
  const source = $("#mirror-source");
  const target = $("#mirror-target");
  const active = draft.ports.find((port) => port.mirrorSource !== null);
  source.replaceChildren();
  target.replaceChildren();
  for (const port of draft.ports) {
    const sourceOption = document.createElement("option");
    sourceOption.value = String(port.idx);
    sourceOption.textContent = `Porta ${port.idx}${port.isUplink ? " (uplink)" : ""}`;
    source.append(sourceOption);
    if (!port.isUplink) {
      const targetOption = document.createElement("option");
      targetOption.value = String(port.idx);
      targetOption.textContent = `Porta ${port.idx}`;
      target.append(targetOption);
    }
  }
  const disabled = document.createElement("option");
  disabled.value = "";
  disabled.textContent = "Desativado";
  target.prepend(disabled);
  target.value = active ? String(active.idx) : "";
  source.value = String(active?.mirrorSource ?? draft.ports[0].idx);
  source.disabled = !active;
}

function renderState() {
  if (!state) return;
  const device = state.device;
  const online = Boolean(device?.online);
  const pill = $("#connection-pill");
  pill.classList.toggle("offline", !online);
  pill.lastElementChild.textContent = device ? online ? "Ligado" : "Sem contacto" : "À espera";
  $("#device-title").textContent = device?.modelDisplay || device?.model || "USW Flex Mini";
  $("#device-subtitle").textContent = device
    ? `${device.hostname || "switch"} · ${device.mac} · comunicação direta por inform`
    : "O switch ainda não enviou um inform para esta aplicação.";
  $("#device-ip").textContent = device?.ip || "—";
  $("#device-firmware").textContent = `Firmware ${device?.firmware || "—"}`;
  $("#metric-state").textContent = online ? "Online" : device ? "Offline" : "Pendente";
  $("#metric-seen").textContent = device ? `Último contacto ${ago(device.lastSeen)}` : "Sem inform recebido";
  $("#metric-model").textContent = device?.modelDisplay || device?.model || "—";
  $("#metric-serial").textContent = device?.serial || "Número de série indisponível";
  const uplink = draft?.ports.find((port) => port.isUplink);
  $("#metric-uplink").textContent = uplink ? `Porta ${uplink.idx}` : "—";
  $("#metric-config").textContent = state.operation?.state === "waiting" ? "À espera" : "Local";
  $("#metric-operation").textContent = state.operation?.state === "waiting"
    ? "O switch ainda não confirmou a nova configuração"
    : state.operation?.state === "applied" ? "Configuração confirmada pelo switch" : "Sem operações pendentes";
  $("#adoption-panel").hidden = !device || device.adopted;
  $("#adopt-url").textContent = state.adoption.informUrl;
  renderPorts();
  renderSnapshots();
  setDirty(dirty);
}

function renderSnapshots() {
  const list = $("#snapshot-list");
  list.replaceChildren();
  if (!state.snapshots.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Ainda não existem alterações.";
    list.append(empty);
    return;
  }
  for (const snapshot of state.snapshots.slice(0, 6)) {
    const row = document.createElement("div");
    row.className = "snapshot";
    const text = document.createElement("div");
    const title = document.createElement("span");
    title.textContent = new Date(snapshot.createdAt).toLocaleString("pt-PT");
    const detail = document.createElement("small");
    detail.textContent = snapshot.reason === "before-apply" ? "Antes de aplicar" : snapshot.reason;
    text.append(title, detail);
    const button = document.createElement("button");
    button.className = "button quiet";
    button.type = "button";
    button.textContent = "Restaurar";
    button.addEventListener("click", () => restore(snapshot.id));
    row.append(text, button);
    list.append(row);
  }
}

function setDirty(value) {
  dirty = value;
  $("#action-bar").hidden = !dirty;
  if (dirty) $("#action-count").textContent = "Reveja o resumo antes de alterar o switch.";
}

function draftChanged() {
  setDirty(true);
  $("#review-panel").hidden = true;
}

async function refresh({ quiet = false } = {}) {
  try {
    state = await api("/api/state");
    csrf = state.csrf;
    if (!dirty || !draft) draft = cloneDraft(state.config);
    else {
      const telemetry = new Map(state.config.ports.map((port) => [port.idx, port]));
      for (const port of draft.ports) Object.assign(port, { up: telemetry.get(port.idx)?.up, speed: telemetry.get(port.idx)?.speed, isUplink: telemetry.get(port.idx)?.isUplink });
    }
    renderState();
  } catch (error) {
    if (!quiet) toast(error.message, true);
    const status = await fetch("/api/status").then((response) => response.json()).catch(() => ({}));
    showLogin(status.device);
  }
}

async function preview() {
  try {
    const result = await api("/api/preview", { method: "POST", body: JSON.stringify({ draft }) });
    previewToken = result.token;
    const list = $("#change-list");
    list.replaceChildren();
    for (const change of result.changes) {
      const item = document.createElement("li");
      item.textContent = change;
      list.append(item);
    }
    $("#review-panel").hidden = false;
    $("#review-panel").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) { toast(error.message, true); }
}

async function apply() {
  if (!previewToken) return;
  const button = $("#apply-button");
  button.disabled = true;
  button.textContent = "A enviar…";
  try {
    await api("/api/apply", { method: "POST", body: JSON.stringify({ token: previewToken }) });
    previewToken = null;
    dirty = false;
    $("#review-panel").hidden = true;
    toast("Configuração em fila. O switch confirma no próximo inform.");
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Aplicar no switch";
  }
}

async function adopt() {
  const button = $("#adopt-button");
  button.disabled = true;
  try {
    const result = await api("/api/adopt", { method: "POST", body: "{}" });
    toast(`Adoção em fila para ${result.informUrl}.`);
    await refresh();
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
}

async function restore(id) {
  try {
    await api(`/api/snapshots/${encodeURIComponent(id)}/restore`, { method: "POST", body: "{}" });
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
    $("#login-view").hidden = true;
    $("#app-view").hidden = false;
    await refresh();
  } catch (error) { $("#login-error").textContent = error.message; }
});
$("#refresh-button").addEventListener("click", () => refresh());
$("#adopt-button").addEventListener("click", adopt);
$("#preview-button").addEventListener("click", preview);
$("#apply-button").addEventListener("click", apply);
$("#close-review").addEventListener("click", () => { $("#review-panel").hidden = true; });
$("#discard-button").addEventListener("click", () => { draft = cloneDraft(state.config); dirty = false; renderState(); });
$("#mirror-target").addEventListener("change", (event) => {
  for (const port of draft.ports) port.mirrorSource = null;
  const target = Number(event.target.value);
  if (target) {
    const source = Number($("#mirror-source").value);
    draft.ports.find((port) => port.idx === target).mirrorSource = source;
  }
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
  $("#login-view").hidden = true;
  $("#app-view").hidden = false;
  await refresh();
} else showLogin(initial.device);
setInterval(() => { if (!$("#app-view").hidden) refresh({ quiet: true }); }, 10_000);
