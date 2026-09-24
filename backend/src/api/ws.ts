import { Server } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { AlarmEngine } from "../alarms/engine";
import { VehicleStateStore } from "../mavlink/state";
import { ActiveAlarm, StatusTextEntry, VehicleState } from "../types";

/** Messages pushed to browser clients. */
export type ServerMessage =
  | { type: "snapshot"; state: VehicleState; alarms: ActiveAlarm[] }
  | { type: "state"; state: Omit<VehicleState, "statusLog"> }
  | { type: "alarms"; alarms: ActiveAlarm[] }
  | { type: "statustext"; entry: StatusTextEntry };

// Telemetry arrives at up to ~50 Hz; the UI does not need more than this.
const STATE_BROADCAST_INTERVAL_MS = 100;

export function attachWebSocket(server: Server, store: VehicleStateStore, alarms: AlarmEngine): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  const broadcast = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  };

  wss.on("connection", (socket) => {
    const snapshot: ServerMessage = { type: "snapshot", state: store.state, alarms: alarms.active };
    socket.send(JSON.stringify(snapshot));
  });

  let pending: NodeJS.Timeout | null = null;
  store.on("update", () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      // statusLog is sent once in the snapshot, then entry by entry.
      const { statusLog: _omit, ...state } = store.state;
      broadcast({ type: "state", state });
    }, STATE_BROADCAST_INTERVAL_MS);
  });
  store.on("statustext", (entry: StatusTextEntry) => broadcast({ type: "statustext", entry }));
  alarms.on("change", (active: ActiveAlarm[]) => broadcast({ type: "alarms", alarms: active }));

  wss.on("close", () => {
    if (pending) clearTimeout(pending);
  });

  return wss;
}
