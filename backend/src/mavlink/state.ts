import { EventEmitter } from "events";
import { common, minimal } from "node-mavlink";
import {
  BatteryState,
  ConnectionInfo,
  GpsState,
  HeartbeatState,
  HomePositionState,
  MissionWaypoint,
  PositionState,
  StatusTextEntry,
  VehicleState,
  VfrHudState,
} from "../types";
import { modeNameForVehicle } from "./modes";

const RAD2DEG = 180 / Math.PI;
const MAX_STATUS_LOG = 200;

function freshConnection(): ConnectionInfo {
  return {
    listening: false,
    connected: false,
    listenPort: null,
    remote: null,
    sysId: null,
    compId: null,
    lastHeartbeatAt: null,
    error: null,
  };
}

export class VehicleStateStore extends EventEmitter {
  state: VehicleState;

  constructor() {
    super();
    this.state = {
      connection: freshConnection(),
      heartbeat: null,
      attitude: null,
      position: null,
      gps: null,
      battery: null,
      vfrHud: null,
      home: null,
      mission: [],
      statusLog: [],
    };
  }

  setConnecting(listenPort: number, remote: { address: string; port: number } | null) {
    this.state.connection = {
      ...freshConnection(),
      listening: true,
      listenPort,
      remote: remote ? `${remote.address}:${remote.port}` : null,
    };
    this.emit("update");
  }

  setError(message: string) {
    this.state.connection = { ...this.state.connection, listening: false, connected: false, error: message };
    this.emit("update");
  }

  markClosed() {
    this.state.connection = { ...this.state.connection, listening: false, connected: false };
    this.emit("update");
  }

  markLinkLost() {
    this.state.connection = { ...this.state.connection, connected: false };
    this.emit("update");
  }

  applyMessage(msgid: number, sysid: number, compid: number, data: unknown, remote: string | null) {
    const now = Date.now();
    this.state.connection.remote = remote;

    switch (msgid) {
      case minimal.Heartbeat.MSG_ID: {
        const hb = data as InstanceType<typeof minimal.Heartbeat>;
        // Track only the autopilot; ignore heartbeats from cameras, gimbals, companion computers.
        if (hb.autopilot === minimal.MavAutopilot.INVALID) break;
        this.state.connection.connected = true;
        this.state.connection.error = null;
        const armed = (hb.baseMode & minimal.MavModeFlag.SAFETY_ARMED) !== 0;
        const hbState: HeartbeatState = {
          vehicleType: hb.type,
          autopilot: hb.autopilot,
          baseMode: hb.baseMode,
          customMode: hb.customMode,
          systemStatus: hb.systemStatus,
          armed,
          flightModeName: modeNameForVehicle(hb.type, hb.customMode),
          timestamp: now,
        };
        this.state.heartbeat = hbState;
        this.state.connection.lastHeartbeatAt = now;
        this.state.connection.sysId = sysid;
        this.state.connection.compId = compid;
        break;
      }
      case common.Attitude.MSG_ID: {
        const att = data as InstanceType<typeof common.Attitude>;
        this.state.attitude = {
          rollDeg: att.roll * RAD2DEG,
          pitchDeg: att.pitch * RAD2DEG,
          yawDeg: ((att.yaw * RAD2DEG) + 360) % 360,
          timestamp: now,
        };
        break;
      }
      case common.GlobalPositionInt.MSG_ID: {
        const pos = data as InstanceType<typeof common.GlobalPositionInt>;
        const position: PositionState = {
          lat: pos.lat / 1e7,
          lon: pos.lon / 1e7,
          altMslM: pos.alt / 1000,
          altRelM: pos.relativeAlt / 1000,
          headingDeg: pos.hdg === 65535 ? (this.state.position?.headingDeg ?? 0) : pos.hdg / 100,
          groundSpeedMs: Math.hypot(pos.vx, pos.vy) / 100,
          timestamp: now,
        };
        this.state.position = position;
        break;
      }
      case common.GpsRawInt.MSG_ID: {
        const gps = data as InstanceType<typeof common.GpsRawInt>;
        const gpsState: GpsState = {
          fixType: gps.fixType,
          satellitesVisible: gps.satellitesVisible === 255 ? 0 : gps.satellitesVisible,
          eph: gps.eph === 65535 ? -1 : gps.eph / 100,
          epv: gps.epv === 65535 ? -1 : gps.epv / 100,
          timestamp: now,
        };
        this.state.gps = gpsState;
        break;
      }
      case common.SysStatus.MSG_ID: {
        const sys = data as InstanceType<typeof common.SysStatus>;
        const battery: BatteryState = {
          voltageV: sys.voltageBattery === 65535 ? null : sys.voltageBattery / 1000,
          currentA: sys.currentBattery === -1 ? null : sys.currentBattery / 100,
          remainingPct: sys.batteryRemaining === -1 ? null : sys.batteryRemaining,
          timestamp: now,
        };
        this.state.battery = battery;
        break;
      }
      case common.VfrHud.MSG_ID: {
        const hud = data as InstanceType<typeof common.VfrHud>;
        const vfr: VfrHudState = {
          airspeedMs: hud.airspeed,
          groundspeedMs: hud.groundspeed,
          headingDeg: hud.heading,
          throttlePct: hud.throttle,
          altMslM: hud.alt,
          climbMs: hud.climb,
          timestamp: now,
        };
        this.state.vfrHud = vfr;
        break;
      }
      case common.HomePosition.MSG_ID: {
        const home = data as InstanceType<typeof common.HomePosition>;
        const homeState: HomePositionState = {
          lat: home.latitude / 1e7,
          lon: home.longitude / 1e7,
          altMslM: home.altitude / 1000,
        };
        this.state.home = homeState;
        break;
      }
      case common.StatusText.MSG_ID: {
        const st = data as InstanceType<typeof common.StatusText>;
        const entry: StatusTextEntry = {
          severity: st.severity,
          text: st.text,
          timestamp: now,
        };
        this.state.statusLog.push(entry);
        if (this.state.statusLog.length > MAX_STATUS_LOG) {
          this.state.statusLog.splice(0, this.state.statusLog.length - MAX_STATUS_LOG);
        }
        this.emit("statustext", entry);
        break;
      }
      case common.MissionCount.MSG_ID: {
        this.emit("missionCount", (data as InstanceType<typeof common.MissionCount>).count);
        break;
      }
      case common.MissionItemInt.MSG_ID: {
        const item = data as InstanceType<typeof common.MissionItemInt>;
        this.emit("missionItem", item);
        break;
      }
      case common.MissionAck.MSG_ID: {
        this.emit("missionAck", data as InstanceType<typeof common.MissionAck>);
        break;
      }
      case common.CommandAck.MSG_ID: {
        this.emit("commandAck", data as InstanceType<typeof common.CommandAck>);
        break;
      }
      default:
        break;
    }

    this.emit("update");
  }

  setMission(waypoints: MissionWaypoint[]) {
    this.state.mission = waypoints;
    this.emit("update");
  }
}
