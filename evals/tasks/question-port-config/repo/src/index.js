import { loadConfig } from "./config.js";
const config = loadConfig(process.env);
console.log(`listening on ${config.port}`);
