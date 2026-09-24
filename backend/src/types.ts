export interface AttitudeState {
  rollDeg: number;
  pitchDeg: number;
  yawDeg: number;
  timestamp: number;
}

export interface PositionState {
  lat: number;
  lon: number;
  altMslM: number;
  altRelM: number;
  headingDeg: number;
  groundSpeedMs: number;
  timestamp: number;
}

export interface GpsState {
  fixType: number;
  satellitesVisible: number;
  eph: number;
  epv: number;
  timestamp: number;
}

export interface BatteryState {
  voltageV: number | null;
  currentA: number | null;
  remainingPct: number | null;
  timestamp: number;
}

export interface VfrHudState {
  airspeedMs: number;
  groundspeedMs: number;
  headingDeg: number;
  throttlePct: number;
  altMslM: number;
  climbMs: number;
  timestamp: number;
}

export interface HeartbeatState {
  vehicleType: number;
  autopilot: number;
  baseMode: number;
  customMode: number;
  systemStatus: number;
  armed: boolean;
  flightModeName: string;
  timestamp: number;
}

export interface HomePositionState {
  lat: number;
  lon: number;
  altMslM: number;
}

export interface StatusTextEntry {
  severity: number;
  text: string;
  timestamp: number;
}

export interface MissionWaypoint {
  seq: number;
  lat: number;
  lon: number;
  altM: number;
  command: number;
  frame: number;
  current: boolean;
  autocontinue: boolean;
  /** MAV_CMD-specific param1..param4. */
  params: [number, number, number, number];
}

/** A mission item as supplied by a client for upload; seq is assigned by position. */
export interface MissionItemInput {
  lat: number;
  lon: number;
  altM: number;
  /** MAV_CMD, defaults to NAV_WAYPOINT (16). */
  command?: number;
  /** MAV_FRAME, defaults to GLOBAL_RELATIVE_ALT_INT (6). */
  frame?: number;
  params?: [number, number, number, number];
}

export interface ConnectionInfo {
  /** UDP socket is bound and listening. */
  listening: boolean;
  /** A vehicle heartbeat has been received recently. */
  connected: boolean;
  listenPort: number | null;
  remote: string | null;
  sysId: number | null;
  compId: number | null;
  lastHeartbeatAt: number | null;
  error: string | null;
}

export interface VehicleState {
  connection: ConnectionInfo;
  heartbeat: HeartbeatState | null;
  attitude: AttitudeState | null;
  position: PositionState | null;
  gps: GpsState | null;
  battery: BatteryState | null;
  vfrHud: VfrHudState | null;
  home: HomePositionState | null;
  mission: MissionWaypoint[];
  statusLog: StatusTextEntry[];
}

export interface ConnectOptions {
  listenPort?: number;
  /** Optional fixed destination; otherwise replies go to the sender of incoming telemetry. */
  remoteHost?: string;
  remotePort?: number;
}

export interface ModeOption {
  id: number;
  name: string;
}

export type AlarmSeverity = "warning" | "critical";

export type AlarmId =
  | "LINK_LOST"
  | "BATTERY_LOW"
  | "BATTERY_CRITICAL"
  | "GPS_FIX_LOST"
  | "VEHICLE_FAILSAFE"
  | "AUTOPILOT_CRITICAL";

export interface AlarmDefinition {
  id: AlarmId;
  severity: AlarmSeverity;
  title: { en: string; ar: string };
}

export interface ActiveAlarm extends AlarmDefinition {
  /** Extra context, e.g. the autopilot STATUSTEXT that raised the alarm. */
  detail: string | null;
  raisedAt: number;
  acknowledged: boolean;
}
