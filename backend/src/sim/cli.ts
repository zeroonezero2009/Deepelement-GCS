import { SimVehicle } from "./vehicle";

// Usage: npm run sim -- [gcsPort] [batteryDrainPctPerSec]
const gcsPort = Number(process.argv[2] ?? process.env.GCS_MAVLINK_PORT ?? 14550);
const batteryDrainPctPerSec = Number(process.argv[3] ?? 0.5);

const sim = new SimVehicle({ gcsPort, batteryDrainPctPerSec });
sim.start().then(() => {
  console.log(`Simulated ArduCopter sending MAVLink to 127.0.0.1:${gcsPort} (battery drain ${batteryDrainPctPerSec}%/s)`);
});

process.on("SIGINT", () => {
  sim.stop().then(() => process.exit(0));
});
