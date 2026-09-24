import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { AddressInfo } from "net";
import { WebSocket } from "ws";
import { createGcsApp, GcsApp } from "./app";
import { SimVehicle } from "./sim/vehicle";

async function until(check: () => boolean, timeoutMs = 3000, what = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("GCS against simulated vehicle", () => {
  let gcs: GcsApp;
  let sim: SimVehicle;
  let baseUrl: string;

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  before(async () => {
    gcs = createGcsApp({ linkTimeoutMs: 600 });
    await new Promise<void>((resolve) => gcs.server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(gcs.server.address() as AddressInfo).port}`;

    const conn = await api("POST", "/connection", { listenPort: 0 });
    assert.equal(conn.status, 200);
    sim = new SimVehicle({ gcsPort: conn.body.listenPort, batteryDrainPctPerSec: 0 });
    await sim.start();
    await until(() => gcs.store.state.connection.connected, 3000, "vehicle heartbeat");
  });

  after(async () => {
    await sim.stop();
    await gcs.close();
  });

  it("receives telemetry and home position", async () => {
    await until(() => gcs.store.state.home !== null && gcs.store.state.battery !== null, 3000, "telemetry");
    assert.equal(gcs.store.state.heartbeat?.flightModeName, "STABILIZE");
    assert.equal(gcs.store.state.home?.lat, 24.7136);
    const modes = await api("GET", "/modes");
    assert.ok(modes.body.some((m: { name: string }) => m.name === "GUIDED"));
  });

  it("runs guided takeoff through the REST API", async () => {
    assert.equal((await api("POST", "/commands/mode", { mode: "guided" })).status, 200);
    assert.equal((await api("POST", "/commands/arm")).status, 200);
    assert.equal((await api("POST", "/commands/takeoff", { altM: 3 })).status, 200);
    await until(() => (gcs.store.state.position?.altRelM ?? 0) > 1, 3000, "climb");
    assert.equal(gcs.store.state.heartbeat?.armed, true);
    assert.equal(gcs.store.state.heartbeat?.flightModeName, "GUIDED");
  });

  it("maps vehicle refusals and bad input to HTTP errors", async () => {
    const disarm = await api("POST", "/commands/disarm");
    assert.equal(disarm.status, 409);
    assert.match(disarm.body.error, /DENIED/);
    assert.equal((await api("POST", "/commands/mode", { mode: "NOPE" })).status, 400);
    assert.equal((await api("POST", "/commands/takeoff", { altM: "x" })).status, 400);
  });

  it("uploads, downloads and clears a mission", async () => {
    const items = [
      { lat: 24.714, lon: 46.676, altM: 20 },
      { lat: 24.715, lon: 46.677, altM: 25 },
    ];
    const up = await api("POST", "/mission/upload", { items });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    // ArduPilot convention: item 0 is home.
    assert.equal(sim.mission.length, 3);
    assert.equal(sim.mission[0].frame, 0);

    const down = await api("POST", "/mission/download");
    assert.equal(down.status, 200);
    assert.deepEqual(
      down.body.slice(1).map((w: { lat: number; lon: number; altM: number }) => ({ lat: w.lat, lon: w.lon, altM: w.altM })),
      items
    );

    assert.equal((await api("DELETE", "/mission")).status, 200);
    assert.equal(sim.mission.length, 0);
    assert.deepEqual((await api("GET", "/mission")).body, []);
  });

  it("pushes alarms over WebSocket and accepts acknowledgement", async () => {
    const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/ws`);
    const messages: { type: string; alarms?: { id: string; acknowledged: boolean }[] }[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(String(data))));
    await until(() => messages.some((m) => m.type === "snapshot"), 2000, "snapshot");

    sim.batteryPct = 20;
    const lastAlarms = () => [...messages].reverse().find((m) => m.type === "alarms")?.alarms ?? [];
    await until(() => lastAlarms().some((a) => a.id === "BATTERY_LOW"), 3000, "battery alarm");

    assert.equal((await api("POST", "/alarms/BATTERY_LOW/ack")).status, 200);
    await until(() => lastAlarms().find((a) => a.id === "BATTERY_LOW")?.acknowledged === true, 2000, "ack");
    assert.equal((await api("POST", "/alarms/BATTERY_LOW/ack")).status, 404);

    sim.batteryPct = 100;
    await until(() => lastAlarms().length === 0, 3000, "battery alarm to clear");
    ws.close();
  });

  it("raises LINK_LOST when heartbeats stop and clears it when they resume", async () => {
    sim.heartbeatPaused = true;
    await until(() => gcs.alarms.active.some((a) => a.id === "LINK_LOST"), 3000, "link lost");
    sim.heartbeatPaused = false;
    await until(() => !gcs.alarms.active.some((a) => a.id === "LINK_LOST"), 3000, "link recovery");
  });
});
