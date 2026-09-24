import { EventEmitter } from "events";
import { common, minimal } from "node-mavlink";
import { VehicleStateStore } from "../mavlink/state";
import { ActiveAlarm, AlarmId, StatusTextEntry } from "../types";
import { ALARM_CATALOG } from "./catalog";

export interface AlarmThresholds {
  batteryLowPct: number;
  batteryCriticalPct: number;
  /** A battery alarm clears only once the level rises this far above its threshold. */
  batteryHysteresisPct: number;
}

export const DEFAULT_THRESHOLDS: AlarmThresholds = {
  batteryLowPct: 25,
  batteryCriticalPct: 10,
  batteryHysteresisPct: 3,
};

type BatteryLevel = "ok" | "low" | "critical";

// Event-driven alarms with no clearing condition: acknowledging them dismisses them.
const TRANSIENT = new Set<AlarmId>(["AUTOPILOT_CRITICAL"]);

const GPS_3D_FIX = common.GpsFixType.GPS_FIX_TYPE_3D_FIX;
const FAILSAFE_STATES = new Set<number>([
  minimal.MavState.CRITICAL,
  minimal.MavState.EMERGENCY,
  minimal.MavState.FLIGHT_TERMINATION,
]);

/**
 * Derives alarms from vehicle state. Emits "change" with the full active list
 * whenever an alarm is raised, cleared or acknowledged.
 */
export class AlarmEngine extends EventEmitter {
  private readonly alarms = new Map<AlarmId, ActiveAlarm>();
  private batteryLevel: BatteryLevel = "ok";
  private hadGpsFix = false;

  constructor(private readonly store: VehicleStateStore, private readonly thresholds = DEFAULT_THRESHOLDS) {
    super();
    store.on("update", () => this.evaluate());
    store.on("statustext", (entry: StatusTextEntry) => this.onStatusText(entry));
  }

  get active(): ActiveAlarm[] {
    return [...this.alarms.values()].sort(
      (a, b) => severityRank(b) - severityRank(a) || a.raisedAt - b.raisedAt
    );
  }

  acknowledge(id: AlarmId): boolean {
    if (!this.ackOne(id)) return false;
    this.changed();
    return true;
  }

  acknowledgeAll() {
    let any = false;
    for (const id of [...this.alarms.keys()]) {
      any = this.ackOne(id) || any;
    }
    if (any) this.changed();
  }

  private ackOne(id: AlarmId): boolean {
    const alarm = this.alarms.get(id);
    if (!alarm || alarm.acknowledged) return false;
    if (TRANSIENT.has(id)) {
      this.alarms.delete(id);
    } else {
      alarm.acknowledged = true;
    }
    return true;
  }

  evaluate() {
    const { connection, battery, gps, heartbeat } = this.store.state;
    let dirty = false;

    if (!connection.listening) {
      // Operator closed the link: nothing to warn about, start fresh next time.
      this.batteryLevel = "ok";
      this.hadGpsFix = false;
      if (this.alarms.size > 0) {
        this.alarms.clear();
        this.changed();
      }
      return;
    }

    const linkLost = connection.lastHeartbeatAt !== null && !connection.connected;
    dirty = this.setCondition("LINK_LOST", linkLost) || dirty;

    this.batteryLevel = nextBatteryLevel(battery?.remainingPct ?? null, this.batteryLevel, this.thresholds);
    dirty = this.setCondition("BATTERY_CRITICAL", this.batteryLevel === "critical") || dirty;
    dirty = this.setCondition("BATTERY_LOW", this.batteryLevel === "low") || dirty;

    if (gps && gps.fixType >= GPS_3D_FIX) this.hadGpsFix = true;
    const gpsLost = this.hadGpsFix && gps !== null && gps.fixType < GPS_3D_FIX;
    dirty = this.setCondition("GPS_FIX_LOST", gpsLost) || dirty;

    const failsafe = heartbeat !== null && FAILSAFE_STATES.has(heartbeat.systemStatus);
    dirty = this.setCondition("VEHICLE_FAILSAFE", failsafe) || dirty;

    if (dirty) this.changed();
  }

  private onStatusText(entry: StatusTextEntry) {
    if (entry.severity > common.MavSeverity.CRITICAL) return;
    // Each new critical message re-raises the alarm so it is announced again.
    this.alarms.set("AUTOPILOT_CRITICAL", {
      ...ALARM_CATALOG.AUTOPILOT_CRITICAL,
      detail: entry.text,
      raisedAt: entry.timestamp,
      acknowledged: false,
    });
    this.changed();
  }

  /** Raises or clears a condition-driven alarm. Returns true if anything changed. */
  private setCondition(id: AlarmId, active: boolean): boolean {
    const existing = this.alarms.get(id);
    if (active && !existing) {
      this.alarms.set(id, { ...ALARM_CATALOG[id], detail: null, raisedAt: Date.now(), acknowledged: false });
      return true;
    }
    if (!active && existing) {
      this.alarms.delete(id);
      return true;
    }
    return false;
  }

  private changed() {
    this.emit("change", this.active);
  }
}

function severityRank(alarm: ActiveAlarm) {
  return alarm.severity === "critical" ? 1 : 0;
}

export function nextBatteryLevel(
  pct: number | null,
  current: BatteryLevel,
  t: AlarmThresholds
): BatteryLevel {
  if (pct === null) return current;
  if (pct <= t.batteryCriticalPct) return "critical";
  if (current === "critical" && pct <= t.batteryCriticalPct + t.batteryHysteresisPct) return "critical";
  if (pct <= t.batteryLowPct) return "low";
  if (current !== "ok" && pct <= t.batteryLowPct + t.batteryHysteresisPct) return "low";
  return "ok";
}
