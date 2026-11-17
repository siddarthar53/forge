import { defaults } from "./defaults.js";
export function loadConfig(env) {
  return { port: Number(env.APP_PORT ?? defaults.port), host: env.HOST ?? "0.0.0.0" };
}
