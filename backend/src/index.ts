import { createGcsApp } from "./app";
import { DEFAULT_LISTEN_PORT } from "./mavlink/connection";

const HTTP_PORT = Number(process.env.GCS_HTTP_PORT ?? 8080);
const MAVLINK_PORT = Number(process.env.GCS_MAVLINK_PORT ?? DEFAULT_LISTEN_PORT);
const AUTOCONNECT = process.env.GCS_AUTOCONNECT !== "0";

async function main() {
  const gcs = createGcsApp();

  await new Promise<void>((resolve) => gcs.server.listen(HTTP_PORT, resolve));
  console.log(`DeepElement GCS UI: http://localhost:${HTTP_PORT}`);

  if (AUTOCONNECT) {
    try {
      await gcs.link.connect({ listenPort: MAVLINK_PORT });
      console.log(`Listening for MAVLink on UDP ${MAVLINK_PORT}`);
    } catch (err) {
      console.error(`MAVLink autoconnect failed: ${(err as Error).message}`);
    }
  }

  const shutdown = async () => {
    await gcs.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
