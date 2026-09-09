import { loadEnv } from "./config/env.js";
import { buildApp } from "./app.js";

const env = loadEnv();
const app = await buildApp(env);

try {
  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  console.log(`API listening on http://${env.API_HOST}:${env.API_PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
