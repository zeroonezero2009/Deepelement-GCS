import express, { NextFunction, Request, Response, Router } from "express";
import { AlarmEngine } from "../alarms/engine";
import { ALARM_CATALOG } from "../alarms/catalog";
import { CommandRejectedError, CommandService } from "../mavlink/commands";
import { MavlinkConnection } from "../mavlink/connection";
import { BusyError, InvalidRequestError, NoLinkError } from "../mavlink/errors";
import { MissionService } from "../mavlink/mission";
import { modeTableForVehicle } from "../mavlink/modes";
import { TimeoutError } from "../mavlink/wait";
import { AlarmId, MissionItemInput, ModeOption } from "../types";

export interface ApiDeps {
  link: MavlinkConnection;
  commands: CommandService;
  mission: MissionService;
  alarms: AlarmEngine;
}

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;

function route(handler: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .then((body) => {
        if (!res.headersSent) res.json(body ?? { ok: true });
      })
      .catch(next);
  };
}

function optionalPort(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new InvalidRequestError(`${name} must be a UDP port`);
  return port;
}

function finiteNumber(value: unknown, name: string): number {
  const n = Number(value);
  if (value === undefined || value === null || value === "" || !Number.isFinite(n)) {
    throw new InvalidRequestError(`${name} must be a number`);
  }
  return n;
}

function parseMissionItems(body: unknown): MissionItemInput[] {
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items)) throw new InvalidRequestError("items must be an array");
  return items.map((raw, i) => {
    const item = raw as Record<string, unknown>;
    const parsed: MissionItemInput = {
      lat: finiteNumber(item.lat, `items[${i}].lat`),
      lon: finiteNumber(item.lon, `items[${i}].lon`),
      altM: finiteNumber(item.altM, `items[${i}].altM`),
    };
    if (Math.abs(parsed.lat) > 90 || Math.abs(parsed.lon) > 180) {
      throw new InvalidRequestError(`items[${i}] has an invalid coordinate`);
    }
    if (item.command !== undefined) parsed.command = finiteNumber(item.command, `items[${i}].command`);
    if (item.frame !== undefined) parsed.frame = finiteNumber(item.frame, `items[${i}].frame`);
    if (item.params !== undefined) {
      if (!Array.isArray(item.params) || item.params.length !== 4) {
        throw new InvalidRequestError(`items[${i}].params must have 4 numbers`);
      }
      parsed.params = item.params.map((p, j) => finiteNumber(p, `items[${i}].params[${j}]`)) as [
        number,
        number,
        number,
        number,
      ];
    }
    return parsed;
  });
}

export function createApiRouter({ link, commands, mission, alarms }: ApiDeps): Router {
  const api = Router();
  api.use(express.json({ limit: "1mb" }));

  api.get("/state", route(() => ({ ...link.store.state, alarms: alarms.active })));

  api.get(
    "/modes",
    route((): ModeOption[] => {
      const vehicleType = link.store.state.heartbeat?.vehicleType;
      if (vehicleType === undefined) return [];
      return Object.entries(modeTableForVehicle(vehicleType)).map(([id, name]) => ({ id: Number(id), name }));
    })
  );

  api.post(
    "/connection",
    route(async (req) => {
      const body = req.body ?? {};
      const remoteHost = typeof body.remoteHost === "string" && body.remoteHost.trim() ? body.remoteHost.trim() : undefined;
      const remotePort = optionalPort(body.remotePort, "remotePort");
      if (Boolean(remoteHost) !== Boolean(remotePort)) {
        throw new InvalidRequestError("remoteHost and remotePort must be given together");
      }
      await link.connect({ listenPort: optionalPort(body.listenPort, "listenPort"), remoteHost, remotePort });
      return link.store.state.connection;
    })
  );

  api.delete(
    "/connection",
    route(async () => {
      await link.disconnect();
      return link.store.state.connection;
    })
  );

  api.post("/commands/arm", route((req) => commands.arm(req.body?.force === true)));
  api.post("/commands/disarm", route((req) => commands.disarm(req.body?.force === true)));
  api.post(
    "/commands/mode",
    route((req) => {
      const mode = req.body?.mode;
      if (typeof mode !== "string" || !mode.trim()) throw new InvalidRequestError("mode is required");
      return commands.setMode(mode);
    })
  );
  api.post(
    "/commands/takeoff",
    route((req) => {
      const altM = finiteNumber(req.body?.altM, "altM");
      if (altM <= 0 || altM > 1000) throw new InvalidRequestError("altM must be between 0 and 1000");
      return commands.takeoff(altM);
    })
  );
  api.post("/commands/land", route(() => commands.land()));
  api.post("/commands/rtl", route(() => commands.returnToLaunch()));

  api.get("/mission", route(() => link.store.state.mission));
  api.post("/mission/download", route(() => mission.download()));
  api.post("/mission/upload", route((req) => mission.upload(parseMissionItems(req.body))));
  api.delete("/mission", route(() => mission.clear()));

  api.get("/alarms", route(() => alarms.active));
  api.get("/alarms/catalog", route(() => Object.values(ALARM_CATALOG)));
  api.post("/alarms/ack", route(() => alarms.acknowledgeAll()));
  api.post(
    "/alarms/:id/ack",
    route((req, res) => {
      const id = req.params.id as AlarmId;
      if (!(id in ALARM_CATALOG)) throw new InvalidRequestError(`Unknown alarm ${id}`);
      if (!alarms.acknowledge(id)) res.status(404).json({ error: `Alarm ${id} is not active or already acknowledged` });
    })
  );

  api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    let status = 500;
    if (err instanceof InvalidRequestError) status = 400;
    else if (err instanceof CommandRejectedError || err instanceof BusyError) status = 409;
    else if (err instanceof NoLinkError) status = 503;
    else if (err instanceof TimeoutError) status = 504;
    else if ((err as { type?: string })?.type === "entity.parse.failed") status = 400;
    res.status(status).json({ error: message });
  });

  return api;
}
