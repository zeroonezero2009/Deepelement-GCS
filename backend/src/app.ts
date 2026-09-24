import cors from "cors";
import express from "express";
import { createServer, Server } from "http";
import path from "path";
import { WebSocketServer } from "ws";
import { AlarmEngine, AlarmThresholds, DEFAULT_THRESHOLDS } from "./alarms/engine";
import { createApiRouter } from "./api/routes";
import { attachWebSocket } from "./api/ws";
import { CommandService } from "./mavlink/commands";
import { MavlinkConnection, MavlinkConnectionOptions } from "./mavlink/connection";
import { MissionService } from "./mavlink/mission";
import { VehicleStateStore } from "./mavlink/state";

// Works from both src/ (tsx) and dist/ (compiled): both sit next to ../frontend.
export const FRONTEND_DIR = path.resolve(__dirname, "../../frontend");

export interface GcsAppOptions extends MavlinkConnectionOptions {
  thresholds?: AlarmThresholds;
  frontendDir?: string;
}

export interface GcsApp {
  server: Server;
  wss: WebSocketServer;
  store: VehicleStateStore;
  link: MavlinkConnection;
  commands: CommandService;
  mission: MissionService;
  alarms: AlarmEngine;
  close(): Promise<void>;
}

export function createGcsApp(options: GcsAppOptions = {}): GcsApp {
  const store = new VehicleStateStore();
  const link = new MavlinkConnection(store, options);
  const commands = new CommandService(link);
  const mission = new MissionService(link);
  const alarms = new AlarmEngine(store, options.thresholds ?? DEFAULT_THRESHOLDS);

  const app = express();
  app.use(cors());
  app.use("/api", createApiRouter({ link, commands, mission, alarms }));
  app.use(express.static(options.frontendDir ?? FRONTEND_DIR));

  const server = createServer(app);
  const wss = attachWebSocket(server, store, alarms);

  return {
    server,
    wss,
    store,
    link,
    commands,
    mission,
    alarms,
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await link.disconnect();
    },
  };
}
