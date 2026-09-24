// ArduPilot custom_mode numbers per vehicle firmware.
// Reference: https://ardupilot.org/dev/docs/mavlink-get-set-flightmode.html
export const ARDUCOPTER_MODES: Record<number, string> = {
  0: "STABILIZE",
  1: "ACRO",
  2: "ALT_HOLD",
  3: "AUTO",
  4: "GUIDED",
  5: "LOITER",
  6: "RTL",
  7: "CIRCLE",
  9: "LAND",
  11: "DRIFT",
  13: "SPORT",
  14: "FLIP",
  15: "AUTOTUNE",
  16: "POSHOLD",
  17: "BRAKE",
  18: "THROW",
  19: "AVOID_ADSB",
  20: "GUIDED_NOGPS",
  21: "SMART_RTL",
  22: "FLOWHOLD",
  23: "FOLLOW",
  24: "ZIGZAG",
  25: "SYSTEMID",
  26: "AUTOROTATE",
  27: "AUTO_RTL",
};

export const ARDUPLANE_MODES: Record<number, string> = {
  0: "MANUAL",
  1: "CIRCLE",
  2: "STABILIZE",
  3: "TRAINING",
  4: "ACRO",
  5: "FLY_BY_WIRE_A",
  6: "FLY_BY_WIRE_B",
  7: "CRUISE",
  8: "AUTOTUNE",
  10: "AUTO",
  11: "RTL",
  12: "LOITER",
  14: "AVOID_ADSB",
  15: "GUIDED",
  17: "QSTABILIZE",
  18: "QHOVER",
  19: "QLOITER",
  20: "QLAND",
  21: "QRTL",
  22: "QAUTOTUNE",
  23: "QACRO",
  24: "THERMAL",
};

// MAV_TYPE values (from mavlink-mappings/minimal), used to pick a mode table.
const COPTER_TYPES = new Set([2, 13, 14, 15]); // QUADROTOR, HEXAROTOR, OCTOROTOR, TRICOPTER
const PLANE_TYPES = new Set([1, 19, 20, 21, 22, 23]); // FIXED_WING, VTOL_*

export function modeNameForVehicle(mavType: number, customMode: number): string {
  if (COPTER_TYPES.has(mavType)) {
    return ARDUCOPTER_MODES[customMode] ?? `MODE_${customMode}`;
  }
  if (PLANE_TYPES.has(mavType)) {
    return ARDUPLANE_MODES[customMode] ?? `MODE_${customMode}`;
  }
  return ARDUCOPTER_MODES[customMode] ?? `MODE_${customMode}`;
}

export function modeTableForVehicle(mavType: number): Record<number, string> {
  if (PLANE_TYPES.has(mavType)) return ARDUPLANE_MODES;
  return ARDUCOPTER_MODES;
}
