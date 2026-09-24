import { createSocket, Socket } from "dgram";
import { PassThrough } from "stream";
import {
  common,
  minimal,
  MavLinkData,
  MavLinkPacket,
  MavLinkPacketParser,
  MavLinkPacketSplitter,
  MavLinkProtocolV2,
} from "node-mavlink";
import { ARDUCOPTER_MODES } from "../mavlink/modes";
import { REGISTRY } from "../mavlink/registry";

type MissionItem = InstanceType<typeof common.MissionItemInt>;

export interface SimVehicleOptions {
  gcsHost?: string;
  gcsPort?: number;
  sysId?: number;
  compId?: number;
  homeLat?: number;
  homeLon?: number;
  homeAltMslM?: number;
  /** Battery % lost per second while armed. */
  batteryDrainPctPerSec?: number;
}

const MODE_BY_NAME = Object.fromEntries(Object.entries(ARDUCOPTER_MODES).map(([id, n]) => [n, Number(id)]));
const TICK_MS = 100;
const METERS_PER_DEG_LAT = 111_320;

/**
 * Minimal ArduCopter stand-in speaking MAVLink over UDP. It streams telemetry,
 * answers commands and the mission protocol, and exposes knobs for tests
 * (battery, GPS, failsafe, heartbeat loss). Not a flight model.
 */
export class SimVehicle {
  readonly opts: Required<SimVehicleOptions>;
  private socket: Socket | null = null;
  private input: PassThrough | null = null;
  private timers: NodeJS.Timeout[] = [];
  private seq = 0;
  private tick = 0;

  armed = false;
  customMode = MODE_BY_NAME.STABILIZE;
  systemStatus: minimal.MavState = minimal.MavState.STANDBY;
  lat: number;
  lon: number;
  altRelM = 0;
  headingDeg = 0;
  targetAltM: number | null = null;
  batteryPct = 100;
  gpsFixType: common.GpsFixType = common.GpsFixType.GPS_FIX_TYPE_3D_FIX;
  heartbeatPaused = false;
  mission: MissionItem[] = [];
  private uploadExpected = 0;

  constructor(options: SimVehicleOptions = {}) {
    this.opts = {
      gcsHost: "127.0.0.1",
      gcsPort: 14550,
      sysId: 1,
      compId: 1,
      homeLat: 24.7136,
      homeLon: 46.6753,
      homeAltMslM: 612,
      batteryDrainPctPerSec: 0.2,
      ...options,
    };
    this.lat = this.opts.homeLat;
    this.lon = this.opts.homeLon;
  }

  get modeName(): string {
    return ARDUCOPTER_MODES[this.customMode] ?? `MODE_${this.customMode}`;
  }

  async start(): Promise<void> {
    const input = new PassThrough();
    input.pipe(new MavLinkPacketSplitter()).pipe(new MavLinkPacketParser())
      .on("data", (packet: MavLinkPacket) => this.handlePacket(packet));
    this.input = input;

    const socket = createSocket("udp4");
    socket.on("message", (buf) => input.write(buf));
    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
    this.socket = socket;

    this.timers.push(setInterval(() => this.step(), TICK_MS));
    this.sendHeartbeat();
  }

  async stop(): Promise<void> {
    this.timers.forEach(clearInterval);
    this.timers = [];
    const socket = this.socket;
    this.socket = null;
    if (socket) await new Promise<void>((resolve) => socket.close(() => resolve()));
    this.input?.end();
    this.input = null;
  }

  statusText(severity: common.MavSeverity, text: string) {
    const msg = new common.StatusText();
    msg.severity = severity;
    msg.text = text;
    this.send(msg);
  }

  private step() {
    this.tick++;
    const dt = TICK_MS / 1000;

    this.fly(dt);
    if (this.armed) {
      this.batteryPct = Math.max(0, this.batteryPct - this.opts.batteryDrainPctPerSec * dt);
    }

    // Rates: heartbeat 1 Hz, sys status / GPS 2 Hz, position / HUD 5 Hz, attitude 10 Hz.
    if (this.tick % 10 === 0) this.sendHeartbeat();
    if (this.tick % 5 === 0) {
      this.sendSysStatus();
      this.sendGps();
    }
    if (this.tick % 2 === 0) {
      this.sendPosition();
      this.sendVfrHud();
    }
    this.sendAttitude();
  }

  private fly(dt: number) {
    if (!this.armed) return;
    const mode = this.modeName;
    if (mode === "LAND" || (mode === "RTL" && this.distanceFromHomeM() < 1)) {
      this.targetAltM = null;
      this.altRelM = Math.max(0, this.altRelM - 1.0 * dt);
      if (this.altRelM === 0) this.disarm("Landed");
      return;
    }
    if (mode === "RTL") {
      const step = Math.min(1, (5 * dt) / Math.max(this.distanceFromHomeM(), 1e-6));
      this.lat += (this.opts.homeLat - this.lat) * step;
      this.lon += (this.opts.homeLon - this.lon) * step;
      return;
    }
    if (this.targetAltM !== null) {
      const diff = this.targetAltM - this.altRelM;
      this.altRelM += Math.sign(diff) * Math.min(Math.abs(diff), 2.5 * dt);
    }
  }

  private distanceFromHomeM() {
    const dLat = (this.lat - this.opts.homeLat) * METERS_PER_DEG_LAT;
    const dLon = (this.lon - this.opts.homeLon) * METERS_PER_DEG_LAT * Math.cos((this.lat * Math.PI) / 180);
    return Math.hypot(dLat, dLon);
  }

  private disarm(reason: string) {
    this.armed = false;
    this.targetAltM = null;
    this.systemStatus = minimal.MavState.STANDBY;
    this.statusText(common.MavSeverity.INFO, `Disarmed: ${reason}`);
  }

  private handlePacket(packet: MavLinkPacket) {
    const clazz = REGISTRY[packet.header.msgid];
    if (!clazz) return;
    const data = packet.protocol.data(packet.payload, clazz);
    switch (packet.header.msgid) {
      case common.CommandLong.MSG_ID:
        this.onCommand(data as InstanceType<typeof common.CommandLong>);
        break;
      case common.MissionRequestList.MSG_ID: {
        const count = new common.MissionCount();
        count.targetSystem = packet.header.sysid;
        count.targetComponent = packet.header.compid;
        count.count = this.mission.length;
        count.missionType = common.MavMissionType.MISSION;
        this.send(count);
        break;
      }
      case common.MissionRequestInt.MSG_ID: {
        const req = data as InstanceType<typeof common.MissionRequestInt>;
        const item = this.mission[req.seq];
        if (item) this.send(item);
        break;
      }
      case common.MissionCount.MSG_ID: {
        const count = data as InstanceType<typeof common.MissionCount>;
        this.uploadExpected = count.count;
        this.mission = [];
        this.requestUploadItem(0);
        break;
      }
      case common.MissionItemInt.MSG_ID: {
        const item = data as MissionItem;
        if (item.seq !== this.mission.length) break;
        this.mission.push(item);
        if (this.mission.length < this.uploadExpected) {
          this.requestUploadItem(this.mission.length);
        } else {
          this.missionAck(common.MavMissionResult.ACCEPTED);
        }
        break;
      }
      case common.MissionClearAll.MSG_ID:
        this.mission = [];
        this.missionAck(common.MavMissionResult.ACCEPTED);
        break;
      default:
        break;
    }
  }

  private onCommand(cmd: InstanceType<typeof common.CommandLong>) {
    const R = common.MavResult;
    let result: common.MavResult = R.UNSUPPORTED;
    switch (cmd.command) {
      case common.MavCmd.COMPONENT_ARM_DISARM:
        if (cmd._param1 === 1) {
          if (this.gpsFixType < common.GpsFixType.GPS_FIX_TYPE_3D_FIX && cmd._param2 !== 21196) {
            result = R.DENIED;
            this.statusText(common.MavSeverity.CRITICAL, "PreArm: Need 3D Fix");
          } else {
            this.armed = true;
            this.systemStatus = minimal.MavState.ACTIVE;
            result = R.ACCEPTED;
          }
        } else {
          if (this.altRelM > 0.5 && cmd._param2 !== 21196) {
            result = R.DENIED;
          } else {
            this.disarm("Disarm command");
            result = R.ACCEPTED;
          }
        }
        break;
      case common.MavCmd.DO_SET_MODE:
        if (ARDUCOPTER_MODES[cmd._param2] !== undefined) {
          this.customMode = cmd._param2;
          result = R.ACCEPTED;
        } else {
          result = R.DENIED;
        }
        break;
      case common.MavCmd.NAV_TAKEOFF:
        if (this.armed && this.modeName === "GUIDED") {
          this.targetAltM = cmd._param7;
          result = R.ACCEPTED;
        } else {
          result = R.FAILED;
        }
        break;
      case common.MavCmd.NAV_LAND:
        this.customMode = MODE_BY_NAME.LAND;
        result = R.ACCEPTED;
        break;
      case common.MavCmd.NAV_RETURN_TO_LAUNCH:
        this.customMode = MODE_BY_NAME.RTL;
        result = R.ACCEPTED;
        break;
      case common.MavCmd.REQUEST_MESSAGE:
        if (cmd._param1 === common.HomePosition.MSG_ID) {
          this.sendHome();
          result = R.ACCEPTED;
        }
        break;
      default:
        break;
    }
    const ack = new common.CommandAck();
    ack.command = cmd.command;
    ack.result = result;
    ack.targetSystem = 255;
    ack.targetComponent = 190;
    this.send(ack);
  }

  private requestUploadItem(seq: number) {
    const req = new common.MissionRequestInt();
    req.targetSystem = 255;
    req.targetComponent = 190;
    req.seq = seq;
    req.missionType = common.MavMissionType.MISSION;
    this.send(req);
  }

  private missionAck(result: common.MavMissionResult) {
    const ack = new common.MissionAck();
    ack.targetSystem = 255;
    ack.targetComponent = 190;
    ack.type = result;
    ack.missionType = common.MavMissionType.MISSION;
    this.send(ack);
  }

  private sendHeartbeat() {
    if (this.heartbeatPaused) return;
    const hb = new minimal.Heartbeat();
    hb.type = minimal.MavType.QUADROTOR;
    hb.autopilot = minimal.MavAutopilot.ARDUPILOTMEGA;
    hb.baseMode = (minimal.MavModeFlag.CUSTOM_MODE_ENABLED |
      (this.armed ? minimal.MavModeFlag.SAFETY_ARMED : 0)) as minimal.MavModeFlag;
    hb.customMode = this.customMode;
    hb.systemStatus = this.systemStatus;
    this.send(hb);
  }

  private sendAttitude() {
    const att = new common.Attitude();
    att.timeBootMs = this.tick * TICK_MS;
    att.roll = this.armed ? Math.sin(this.tick / 20) * 0.05 : 0;
    att.pitch = this.armed ? Math.cos(this.tick / 25) * 0.04 : 0;
    att.yaw = (this.headingDeg * Math.PI) / 180;
    this.send(att);
  }

  private sendPosition() {
    const pos = new common.GlobalPositionInt();
    pos.timeBootMs = this.tick * TICK_MS;
    pos.lat = Math.round(this.lat * 1e7);
    pos.lon = Math.round(this.lon * 1e7);
    pos.alt = Math.round((this.opts.homeAltMslM + this.altRelM) * 1000);
    pos.relativeAlt = Math.round(this.altRelM * 1000);
    pos.hdg = Math.round(this.headingDeg * 100);
    this.send(pos);
  }

  private sendVfrHud() {
    const hud = new common.VfrHud();
    hud.heading = Math.round(this.headingDeg);
    hud.throttle = this.armed ? 45 : 0;
    hud.alt = this.opts.homeAltMslM + this.altRelM;
    hud.climb = 0;
    this.send(hud);
  }

  private sendGps() {
    const gps = new common.GpsRawInt();
    gps.fixType = this.gpsFixType;
    gps.lat = Math.round(this.lat * 1e7);
    gps.lon = Math.round(this.lon * 1e7);
    gps.satellitesVisible = this.gpsFixType >= common.GpsFixType.GPS_FIX_TYPE_3D_FIX ? 14 : 3;
    gps.eph = 80;
    gps.epv = 120;
    this.send(gps);
  }

  private sendSysStatus() {
    const sys = new common.SysStatus();
    sys.voltageBattery = Math.round((13.2 + (16.8 - 13.2) * (this.batteryPct / 100)) * 1000);
    sys.currentBattery = this.armed ? 1800 : 50;
    sys.batteryRemaining = Math.round(this.batteryPct);
    this.send(sys);
  }

  private sendHome() {
    const home = new common.HomePosition();
    home.latitude = Math.round(this.opts.homeLat * 1e7);
    home.longitude = Math.round(this.opts.homeLon * 1e7);
    home.altitude = Math.round(this.opts.homeAltMslM * 1000);
    home.q = [1, 0, 0, 0];
    this.send(home);
  }

  private send(msg: MavLinkData) {
    if (!this.socket) return;
    const protocol = new MavLinkProtocolV2(this.opts.sysId, this.opts.compId);
    const buffer = protocol.serialize(msg, this.seq);
    this.seq = (this.seq + 1) & 255;
    this.socket.send(buffer, this.opts.gcsPort, this.opts.gcsHost);
  }
}
