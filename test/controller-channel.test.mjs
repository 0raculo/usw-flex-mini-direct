import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { controllerChannelPayload, sendControllerChannel } from "../src/controller-channel.mjs";

test("entrega o pedido TLS JSON de fábrica sem credenciais privadas do controlador", async () => {
  let connectOptions;
  let written;
  const socket = new EventEmitter();
  socket.end = (value) => {
    written = value;
    queueMicrotask(() => socket.emit("end"));
  };
  socket.resume = () => {};
  socket.destroy = () => {};
  const result = await sendControllerChannel({
    host: "192.0.2.96",
    port: 22,
    mac: "74:83:c2:0f:39:35",
    informUrl: "http://192.0.2.10:8080/inform",
    connect: (options) => {
      connectOptions = options;
      queueMicrotask(() => socket.emit("secureConnect"));
      return socket;
    }
  });
  assert.equal(connectOptions.rejectUnauthorized, false);
  assert.equal(result.sent, true);
  assert.deepEqual(JSON.parse(written), controllerChannelPayload({
    mac: "74:83:c2:0f:39:35",
    ip: "192.0.2.96",
    informUrl: "http://192.0.2.10:8080/inform"
  }));
  assert.equal(JSON.parse(written).key, null);
  assert.equal(JSON.parse(written).authkey, "ba86f2bbe107c7c57eb5f2690775c712");
});
