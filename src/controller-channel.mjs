import tls from "node:tls";

export function controllerChannelPayload({ mac, ip, informUrl, port = 22 }) {
  return {
    type: "adopt",
    mac,
    device_type: "usw",
    ip,
    port,
    username: "ubnt",
    password: "ubnt",
    url: informUrl,
    authkey: "ba86f2bbe107c7c57eb5f2690775c712",
    key: null
  };
}

export function sendControllerChannel({
  host,
  port = 22,
  mac,
  informUrl,
  timeoutMs = 5000,
  connect = tls.connect
}) {
  const payload = controllerChannelPayload({ mac, ip: host, informUrl, port });
  return new Promise((resolve, reject) => {
    let finished = false;
    const socket = connect({ host, port, rejectUnauthorized: false });
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ sent: true, payload });
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new Error("O canal TLS do switch não respondeu ao pedido de gestão."));
    }, timeoutMs);
    socket.once("secureConnect", () => {
      socket.resume();
      socket.end(JSON.stringify(payload), () => finish());
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => finish());
    socket.once("end", () => finish());
  });
}
