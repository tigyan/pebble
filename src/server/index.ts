import { loadConfig } from "../config.js";
import { openDB } from "../db/client.js";
import { buildServer } from "./server.js";

async function main() {
  const config = loadConfig();
  const db = openDB(config.dbPath);
  const app = await buildServer({ config, db });

  const close = async () => {
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`pebble server ready on http://${config.host}:${config.port}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
