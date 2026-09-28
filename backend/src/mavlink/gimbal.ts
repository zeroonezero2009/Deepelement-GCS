import { common } from "node-mavlink";
import { MavlinkConnection } from "./connection";

/**
 * Camera-gimbal control: stabilization + geographic pointing.
 *
 * A gimbal has up to three rotational axes — pitch (tilt), roll, and yaw (pan/heading).
 * The vendor config (UavPara.ini [SETCHANEL]) exposes a gain (`_K`) and an angle
 * limit (`_LIMIT`) per axis; this module reproduces that logic in the open.
 */

export interface GimbalAxisConfig {
  /** Stabilization gain: gimbalAngle = -K * aircraftAngle. 1.0 = full compensation. */
  k: number;
  /** Absolute angle limit in degrees; the commanded angle is clamped to +/- this. */
  limitDeg: number;
}

export interface GimbalConfig {
  pitch: GimbalAxisConfig;
  roll: GimbalAxisConfig;
  yaw: GimbalAxisConfig;
}

export const DEFAULT_GIMBAL_CONFIG: GimbalConfig = {
  pitch: { k: 1, limitDeg: 90 },
  roll: { k: 1, limitDeg: 45 },
  yaw: { k: 1, limitDeg: 180 },
};

export interface Attitude {
  rollDeg: number;
  pitchDeg: number;
  yawDeg: number;
}

export interface GeoPoint {
  lat: number;
  lon: number;
  altMslM: number;
}

export interface GimbalAngles {
  pitchDeg: number;
  rollDeg: number;
  yawDeg: number;
}

const clamp = (v: number, limit: number) => Math.max(-limit, Math.min(limit, v));
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;
const EARTH_RADIUS_M = 6371000;

/**
 * Stabilization mode: keep the camera level by counter-rotating against the
 * aircraft's attitude. Each axis is scaled by its gain and clamped to its limit.
 */
export function stabilizationAngles(aircraft: Attitude, cfg: GimbalConfig): GimbalAngles {
  return {
    pitchDeg: clamp(-cfg.pitch.k * aircraft.pitchDeg, cfg.pitch.limitDeg),
    rollDeg: clamp(-cfg.roll.k * aircraft.rollDeg, cfg.roll.limitDeg),
    yawDeg: clamp(-cfg.yaw.k * aircraft.yawDeg, cfg.yaw.limitDeg),
  };
}

/**
 * Local ENU offset (east, north metres) from `from` to `to`, using an
 * equirectangular approximation — accurate over the short ranges a gimbal points across.
 */
function enuOffset(from: GeoPoint, to: GeoPoint): { east: number; north: number } {
  const east = toRad(to.lon - from.lon) * EARTH_RADIUS_M * Math.cos(toRad(from.lat));
  const north = toRad(to.lat - from.lat) * EARTH_RADIUS_M;
  return { east, north };
}

/**
 * Pointing mode: aim the camera at a geographic target (region of interest).
 * Pitch is the depression angle below horizontal; yaw is the absolute bearing
 * from the aircraft to the target. Roll stays level.
 */
export function pointingAngles(aircraft: GeoPoint, target: GeoPoint, cfg: GimbalConfig): GimbalAngles {
  const { east, north } = enuOffset(aircraft, target);
  const horizontal = Math.hypot(east, north);
  const dz = aircraft.altMslM - target.altMslM; // positive when aircraft is above target

  // Depression angle: how far below the horizon the camera must tilt.
  const pitchDeg = -toDeg(Math.atan2(dz, horizontal));
  // Bearing: clockwise from north, 0..360.
  const yawDeg = (toDeg(Math.atan2(east, north)) + 360) % 360;

  return {
    pitchDeg: clamp(pitchDeg, cfg.pitch.limitDeg),
    rollDeg: 0,
    yawDeg,
  };
}

export class GimbalController {
  constructor(
    private readonly link: MavlinkConnection,
    public config: GimbalConfig = DEFAULT_GIMBAL_CONFIG
  ) {}

  /** Send absolute gimbal angles via MAV_CMD_DO_MOUNT_CONTROL. */
  async setAngles(angles: GimbalAngles): Promise<void> {
    const cmd = new common.DoMountControlCommand();
    cmd.pitch = clamp(angles.pitchDeg, this.config.pitch.limitDeg);
    cmd.roll = clamp(angles.rollDeg, this.config.roll.limitDeg);
    cmd.yaw = clamp(angles.yawDeg, this.config.yaw.limitDeg);
    cmd.mode = common.MavMountMode.MAVLINK_TARGETING;
    await this.link.send(cmd);
  }

  /** Point the camera at a geographic coordinate (region of interest). */
  async pointAt(aircraft: GeoPoint, target: GeoPoint): Promise<void> {
    await this.setAngles(pointingAngles(aircraft, target, this.config));
  }

  /** Hold the camera level against the aircraft's current attitude. */
  async stabilize(aircraft: Attitude): Promise<void> {
    await this.setAngles(stabilizationAngles(aircraft, this.config));
  }
}
