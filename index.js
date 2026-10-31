#!/usr/bin/env node
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { startChat } from "./src/chat.js";

// 1. Load .env from DevPilot's own folder, not from the project you run it in.
//    That way you can `cd` into any repo and run DevPilot there.
dotenv.config({ path: fileURLToPath(new URL(".env", import.meta.url)), quiet: true });

const HELP = `DevPilot, a coding agent for the terminal.

Usage:
  devpilot                    start a new conversation in this folder
  devpilot --continue, -c     continue the most recent conversation
  devpilot --resume, -r       pick a saved conversation to continue
  devpilot --resume <file>    continue a specific .devpilot/sessions/*.jsonl

Inside DevPilot, type /help for the slash commands.`;

// 2. Command-line flags
function parseArgs(argv) {
  const args = { resume: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "-c" || arg === "--continue") args.resume = "latest";
    else if (arg === "-r" || arg === "--resume") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        args.resume = next;
        i++;
      } else {
        args.resume = "pick";
      }
    } else {
      throw new Error(`Unknown option "${arg}". Try --help.`);
    }
  }
  return args;
}

// 3. Application configuration (environment variables, see README)
function loadConfig(args) {
  const env = process.env;
  const config = {
    apiKey: env.OPENROUTER_API_KEY,
    // Any OpenAI-compatible endpoint works; OpenRouter is the default.
    baseURL: env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    model: env.OPENROUTER_MODEL,
    maxSteps: Number(env.DEVPILOT_MAX_STEPS ?? 25),
    // Context window in tokens. Normally read from OpenRouter's model list.
    contextWindow: Number(env.DEVPILOT_CONTEXT_WINDOW) || null,
    // Compact the conversation when the context is this full (0 to 1).
    compactAt: Number(env.DEVPILOT_COMPACT_AT ?? 0.8),
    // Create a devpilot/* branch before the first edit when on main/master.
    autoBranch: env.DEVPILOT_AUTO_BRANCH !== "0",
    // Run shell commands in Docker: DEVPILOT_SANDBOX=docker
    sandbox:
      env.DEVPILOT_SANDBOX === "docker"
        ? { image: env.DEVPILOT_SANDBOX_IMAGE || "node:22", network: env.DEVPILOT_SANDBOX_NETWORK === "1" }
        : null,
    resume: args.resume,
  };

  // 4. Validate configuration
  if (!config.apiKey) throw new Error("OPENROUTER_API_KEY is missing");
  if (!config.model) throw new Error("OPENROUTER_MODEL is missing (pick a model that supports tool calling)");
  if (!(config.compactAt > 0 && config.compactAt <= 1)) throw new Error("DEVPILOT_COMPACT_AT must be between 0 and 1");
  if (env.DEVPILOT_SANDBOX && !config.sandbox) throw new Error('DEVPILOT_SANDBOX supports only "docker"');
  return config;
}

// 5. Application entry point
async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(HELP);
      return;
    }
    const config = loadConfig(args);

    // OpenRouter speaks the OpenAI API format.
    const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });
    await startChat({ client, config });
  } catch (error) {
    console.error("DevPilot failed:", error.message);
    process.exitCode = 1;
  }
}

main();
