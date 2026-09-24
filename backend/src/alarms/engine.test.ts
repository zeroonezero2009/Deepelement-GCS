import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { common, minimal } from "node-mavlink";
import { VehicleStateStore } from "../mavlink/state";
import { AlarmEngine, DEFAULT_THRESHOLDS, nextBatteryLevel } from "./engine";

function setup() {
  const store = new VehicleStateStore();
  const engine = new AlarmEngine(store);
  store.setConnecting(14550, null);
  const ids = () => engine.active.map((a) => a.id);
  const battery = (pct: number) => {
    store.state.battery = { voltageV: 15, currentA: 1, remainingPct: pct, timestamp: Date.now() };
    store.emit("update");
  };
  const gps = (fixType: number) => {
    store.state.gps = { fixType, satellitesVisible: 10, eph: 1, epv: 1, timestamp: Date.now() };
    store.emit("update");
  };
  return { store, engine, ids, battery, gps };
}

describe("nextBatteryLevel", () => {
  const t = DEFAULT_THRESHOLDS;
  it("applies hysteresis on the way back up", () => {
    assert.equal(nextBatteryLevel(26, "ok", t), "ok");
    assert.equal(nextBatteryLevel(25, "ok", t), "low");
    assert.equal(nextBatteryLevel(27, "low", t), "low");
    assert.equal(nextBatteryLevel(29, "low", t), "ok");
    assert.equal(nextBatteryLevel(10, "low", t), "critical");
    assert.equal(nextBatteryLevel(12, "critical", t), "critical");
    assert.equal(nextBatteryLevel(14, "critical", t), "low");
    assert.equal(nextBatteryLevel(null, "low", t), "low");
  });
});

describe("AlarmEngine", () => {
  it("raises battery low then replaces it with critical", () => {
    const { ids, battery } = setup();
    battery(50);
    assert.deepEqual(ids(), []);
    battery(20);
    assert.deepEqual(ids(), ["BATTERY_LOW"]);
    battery(8);
    assert.deepEqual(ids(), ["BATTERY_CRITICAL"]);
  });

  it("raises GPS loss only after a 3D fix was seen", () => {
    const { ids, gps } = setup();
    gps(common.GpsFixType.NO_FIX);
    assert.deepEqual(ids(), []);
    gps(common.GpsFixType.GPS_FIX_TYPE_3D_FIX);
    gps(common.GpsFixType.NO_FIX);
    assert.deepEqual(ids(), ["GPS_FIX_LOST"]);
    gps(common.GpsFixType.RTK_FIXED);
    assert.deepEqual(ids(), []);
  });

  it("raises link lost after heartbeats stop, not before any were seen", () => {
    const { store, ids } = setup();
    store.markLinkLost();
    assert.deepEqual(ids(), []);
    store.state.connection.lastHeartbeatAt = Date.now();
    store.state.connection.connected = true;
    store.markLinkLost();
    assert.deepEqual(ids(), ["LINK_LOST"]);
  });

  it("raises failsafe from heartbeat system status", () => {
    const { store, ids } = setup();
    const hb = new minimal.Heartbeat();
    hb.type = minimal.MavType.QUADROTOR;
    hb.autopilot = minimal.MavAutopilot.ARDUPILOTMEGA;
    hb.systemStatus = minimal.MavState.CRITICAL;
    store.applyMessage(minimal.Heartbeat.MSG_ID, 1, 1, hb, null);
    assert.deepEqual(ids(), ["VEHICLE_FAILSAFE"]);
  });

  it("keeps acknowledged condition alarms but dismisses transient ones", () => {
    const { store, engine, battery } = setup();
    battery(20);
    const st = new common.StatusText();
    st.severity = common.MavSeverity.CRITICAL;
    st.text = "EKF variance";
    store.applyMessage(common.StatusText.MSG_ID, 1, 1, st, null);
    // Critical sorts before warning.
    assert.deepEqual(engine.active.map((a) => a.id), ["AUTOPILOT_CRITICAL", "BATTERY_LOW"]);
    assert.equal(engine.active[0].detail, "EKF variance");

    engine.acknowledgeAll();
    assert.deepEqual(
      engine.active.map((a) => [a.id, a.acknowledged]),
      [["BATTERY_LOW", true]]
    );
  });

  it("ignores non-critical status text", () => {
    const { store, ids } = setup();
    const st = new common.StatusText();
    st.severity = common.MavSeverity.WARNING;
    st.text = "just a warning";
    store.applyMessage(common.StatusText.MSG_ID, 1, 1, st, null);
    assert.deepEqual(ids(), []);
  });

  it("clears everything when the operator closes the link", () => {
    const { store, ids, battery } = setup();
    battery(5);
    assert.deepEqual(ids(), ["BATTERY_CRITICAL"]);
    store.markClosed();
    assert.deepEqual(ids(), []);
  });

  it("emits change only when the active set changes", () => {
    const { engine, battery } = setup();
    let changes = 0;
    engine.on("change", () => changes++);
    battery(20);
    battery(19);
    battery(18);
    assert.equal(changes, 1);
  });
});
