import { AlarmDefinition, AlarmId } from "../types";

export const ALARM_CATALOG: Record<AlarmId, AlarmDefinition> = {
  LINK_LOST: {
    id: "LINK_LOST",
    severity: "critical",
    title: { en: "Telemetry link lost", ar: "انقطع الاتصال بالطائرة" },
  },
  BATTERY_CRITICAL: {
    id: "BATTERY_CRITICAL",
    severity: "critical",
    title: { en: "Battery critical", ar: "البطارية في مستوى حرج" },
  },
  BATTERY_LOW: {
    id: "BATTERY_LOW",
    severity: "warning",
    title: { en: "Battery low", ar: "البطارية منخفضة" },
  },
  GPS_FIX_LOST: {
    id: "GPS_FIX_LOST",
    severity: "warning",
    title: { en: "GPS fix lost", ar: "فقدان إشارة GPS" },
  },
  VEHICLE_FAILSAFE: {
    id: "VEHICLE_FAILSAFE",
    severity: "critical",
    title: { en: "Vehicle failsafe or emergency", ar: "الطائرة في وضع الطوارئ" },
  },
  AUTOPILOT_CRITICAL: {
    id: "AUTOPILOT_CRITICAL",
    severity: "critical",
    title: { en: "Critical autopilot message", ar: "رسالة حرجة من الطيار الآلي" },
  },
};
