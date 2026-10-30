#!/usr/bin/env node
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { startChat } from "./src/chat.js";

// 1. Load .env from DevPilot's own folder, not from the project you run it in.
//    That way you can `cd` into any repo and run DevPilot there.
dotenv.config({ path: fileURLToPath(new URL(".env", import.meta.url)), quiet: true });

// 2. Application configuration
const config = {
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  model: process.env.OPENROUTER_MODEL,
  maxSteps: Number(process.env.DEVPILOT_MAX_STEPS ?? 25),
};

// 3. Validate configuration
if (!config.apiKey) {
  throw new Error("OPENROUTER_API_KEY is missing");
}

if (!config.model) {
  throw new Error("OPENROUTER_MODEL is missing (pick a model that supports tool calling)");
}

// 4. Create API client (OpenRouter speaks the OpenAI API format)
const client = new OpenAI({
  baseURL: config.baseURL,
  apiKey: config.apiKey,
});

// 5. Application entry point
async function main() {
  try {
    await startChat({
      client,
      model: config.model,
      maxSteps: config.maxSteps,
    });
  } catch (error) {
    console.error("DevPilot failed:", error.message);
    process.exitCode = 1;
  }
}

main();
