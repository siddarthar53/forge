#!/usr/bin/env node
// Run DevPilot on the eval tasks and grade it.
//
//   node evals/run.js                         all tasks, once, with the model in .env
//   node evals/run.js --runs 3                each task 3 times (pass^3)
//   node evals/run.js --tasks bugfix,safety   only some tasks (id prefix or category)
//   node evals/run.js --model anthropic/claude-haiku-4.5
//   node evals/run.js --label no-explorers --env DEVPILOT_SUBAGENTS=0
//   node evals/run.js --approve all           approve every command (use with DEVPILOT_SANDBOX=docker)
//
// Results go to evals/results/<label>/: summary.md, summary.json, runs.jsonl
// and each run's session log.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeEvents, readEvents } from "./lib/analyze.js";
import { runDevPilot } from "./lib/devpilot.js";
import { fmt, mean, pct, table } from "./lib/report.js";
import { grade, loadTasks, prepareWorkspace } from "./lib/tasks.js";

const RESULTS_DIR = fileURLToPath(new URL("./results", import.meta.url));

// The model DevPilot will use: --model, else OPENROUTER_MODEL from the
// environment or DevPilot's .env (read the same way DevPilot reads it).
function resolveModel(opts) {
  if (opts.model) return opts.model;
  if (process.env.OPENROUTER_MODEL) return process.env.OPENROUTER_MODEL;
  const envFile = fileURLToPath(new URL("../.env", import.meta.url));
  if (!existsSync(envFile)) return null;
  const line = readFileSync(envFile, "utf8").split(/\r?\n/).find((l) => /^\s*OPENROUTER_MODEL\s*=/.test(l));
  return line ? line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "") : null;
}

// Provider errors that are not the agent's fault (rate limits, outages).
const INFRA_ERROR = /\b(429|rate.?limit|too many requests|502|503|overloaded|upstream|provider returned error)\b/i;

function parseArgs(argv) {
  const opts = { runs: 1, tasks: null, model: null, label: null, out: null, env: {}, approve: "safe", concurrency: 1, timeoutMin: 6, freeOnly: false, maxCost: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === "--runs") opts.runs = Number(next());
    else if (arg === "--tasks") opts.tasks = next();
    else if (arg === "--model") opts.model = next();
    else if (arg === "--label") opts.label = next();
    else if (arg === "--out") opts.out = next();
    else if (arg === "--approve") opts.approve = next();
    else if (arg === "--concurrency") opts.concurrency = Number(next());
    else if (arg === "--timeout") opts.timeoutMin = Number(next());
    else if (arg === "--free-only") opts.freeOnly = true;
    else if (arg === "--max-cost") opts.maxCost = Number(next());
    else if (arg === "--env") {
      const [key, ...rest] = next().split("=");
      opts.env[key] = rest.join("=");
    } else if (arg === "-h" || arg === "--help") {
      console.log(readHelp());
      process.exit(0);
    } else throw new Error(`Unknown option ${arg}. Try --help.`);
  }
  if (!["safe", "all"].includes(opts.approve)) throw new Error('--approve must be "safe" or "all"');
  if (!(opts.runs >= 1)) throw new Error("--runs must be 1 or more");
  return opts;
}

function readHelp() {
  return `Usage: node evals/run.js [--runs N] [--tasks ids|categories] [--model id] [--label name]
                          [--env KEY=VALUE]... [--approve safe|all] [--concurrency N] [--timeout minutes]
                          [--out folder] [--free-only] [--max-cost dollars]

  --free-only        refuse to run unless the model id ends in ":free", and stop
                     if any run reports a cost above $0
  --max-cost N       stop starting new runs once the total cost passes $N`;
}

// A claim of success in the final answer (for "said it was done, but tests fail").
const GAVE_UP = /\b(can(no|')t|unable|couldn't|could not|not able|failed to|I don't|need more|clarif)/i;

async function runOne(task, runIndex, opts, outDir) {
  const ws = prepareWorkspace(task);
  const env = {
    ...opts.env,
    HOME: ws.home,
    USERPROFILE: ws.home,
    DEVPILOT_AUTO_BRANCH: opts.env.DEVPILOT_AUTO_BRANCH ?? "0",
  };
  if (opts.model) env.OPENROUTER_MODEL = opts.model;

  const record = await runDevPilot({
    cwd: ws.work,
    prompt: task.prompt,
    env,
    approvals: { mode: opts.approve, decline: task.approvals?.decline ?? [] },
    timeoutMs: opts.timeoutMin * 60_000,
  });

  const logFile = record.ready?.logFile;
  const events = logFile && existsSync(logFile) ? readEvents(logFile) : [];
  const metrics = analyzeEvents(events);
  const result = grade(task, ws.work, record, metrics, events);

  if (logFile && existsSync(logFile)) {
    mkdirSync(path.join(outDir, "logs"), { recursive: true });
    copyFileSync(logFile, path.join(outDir, "logs", `${task.id}-${runIndex + 1}.jsonl`));
  }

  const claimedDone = ["bugfix", "feature"].includes(task.category) && Boolean(metrics.finalAnswer) && !GAVE_UP.test(metrics.finalAnswer);
  const run = {
    task: task.id,
    category: task.category,
    run: runIndex + 1,
    pass: result.pass,
    reasons: result.reasons,
    testDetail: result.testDetail,
    status: record.status,
    model: record.ready?.model ?? metrics.model,
    durationMs: record.durationMs,
    apiCalls: metrics.apiCalls,
    tokens: metrics.promptTokens + metrics.completionTokens,
    cachedTokens: metrics.cachedTokens,
    promptTokens: metrics.promptTokens,
    cost: metrics.cost,
    toolCalls: metrics.toolCalls,
    toolErrors: metrics.toolErrors,
    failedCommands: metrics.failedCommands,
    resultKinds: metrics.resultKinds,
    toolCallsByName: metrics.toolCallsByName,
    nudges: metrics.nudges,
    compactions: metrics.compactions,
    subagents: metrics.subagents,
    edits: metrics.edits,
    verifiedAfterLastEdit: metrics.verifiedAfterLastEdit,
    claimedDone,
    falseDone: claimedDone && !result.pass,
    changedFiles: result.changed,
    declinedByPolicy: record.approvals.filter((a) => a.by === "policy" && a.answer !== "y").length,
    blockedCommands: metrics.blockedCommands,
    finalAnswer: (metrics.finalAnswer || record.text).slice(0, 600),
    errors: record.errors,
    // A rate limit or provider outage says nothing about the agent: such runs
    // are reported but left out of the pass rates.
    infraError: record.errors.some((e) => INFRA_ERROR.test(e)) || INFRA_ERROR.test(record.stderr ?? ""),
  };
  if (run.infraError && !run.pass) run.reasons.push("provider error (rate limit or outage), not counted");
  appendFileSync(path.join(outDir, "runs.jsonl"), JSON.stringify(run) + "\n");
  return run;
}

export function summarize(allRuns, meta) {
  const runs = allRuns.filter((r) => !(r.infraError && !r.pass));
  const excluded = allRuns.length - runs.length;
  const byTask = new Map();
  for (const r of runs) {
    if (!byTask.has(r.task)) byTask.set(r.task, []);
    byTask.get(r.task).push(r);
  }
  const tasks = [...byTask.entries()].map(([id, list]) => ({
    id,
    category: list[0].category,
    runs: list.length,
    passes: list.filter((r) => r.pass).length,
    allPassed: list.every((r) => r.pass),
    apiCalls: mean(list.map((r) => r.apiCalls)),
    tokens: mean(list.map((r) => r.tokens)),
    cost: mean(list.map((r) => r.cost)),
    seconds: mean(list.map((r) => r.durationMs / 1000)),
    reasons: [...new Set(list.flatMap((r) => r.reasons))],
  }));

  const categories = {};
  for (const t of tasks) {
    categories[t.category] ??= { tasks: 0, passRate: [], allPassed: 0 };
    categories[t.category].tasks++;
    categories[t.category].passRate.push(t.passes / t.runs);
    if (t.allPassed) categories[t.category].allPassed++;
  }
  for (const c of Object.values(categories)) c.passRate = mean(c.passRate);

  const passing = runs.filter((r) => r.pass);
  const sum = (key) => runs.reduce((n, r) => n + (r[key] ?? 0), 0);
  const kinds = {};
  for (const r of runs) for (const [k, n] of Object.entries(r.resultKinds ?? {})) kinds[k] = (kinds[k] ?? 0) + n;
  const withEdits = runs.filter((r) => r.verifiedAfterLastEdit !== null);
  const codeRuns = runs.filter((r) => ["bugfix", "feature"].includes(r.category));

  return {
    ...meta,
    excludedRuns: excluded,
    runsPerTask: tasks.length ? Math.max(...tasks.map((t) => t.runs)) : 0,
    passAt1: mean(tasks.map((t) => t.passes / t.runs)),
    passAllK: tasks.length ? tasks.filter((t) => t.allPassed).length / tasks.length : NaN,
    categories,
    tasks,
    efficiency: {
      apiCalls: mean(runs.map((r) => r.apiCalls)),
      tokens: mean(runs.map((r) => r.tokens)),
      cost: mean(runs.map((r) => r.cost)),
      seconds: mean(runs.map((r) => r.durationMs / 1000)),
      costPerPass: passing.length ? sum("cost") / passing.length : NaN,
      cacheHitRate: sum("promptTokens") ? sum("cachedTokens") / sum("promptTokens") : 0,
      totalCost: allRuns.reduce((n, r) => n + (r.cost ?? 0), 0),
    },
    behaviour: {
      toolCalls: sum("toolCalls"),
      toolErrorRate: sum("toolCalls") ? sum("toolErrors") / sum("toolCalls") : 0,
      resultKinds: kinds,
      failedCommands: sum("failedCommands"),
      nudges: sum("nudges"),
      compactions: sum("compactions"),
      subagents: sum("subagents"),
      verificationRate: withEdits.length ? withEdits.filter((r) => r.verifiedAfterLastEdit).length / withEdits.length : NaN,
      falseDone: codeRuns.filter((r) => r.falseDone).length,
      codeRuns: codeRuns.length,
      declinedByPolicy: sum("declinedByPolicy"),
      timeouts: runs.filter((r) => r.status === "timeout").length,
    },
  };
}

export function renderSummary(s) {
  const lines = [];
  lines.push(`# DevPilot eval: ${s.label}\n`);
  lines.push(`Model \`${s.model}\` · ${s.tasks.length} tasks × ${s.runsPerTask} run(s) · ${s.date}` + (Object.keys(s.env).length ? ` · env ${Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join(" ")}` : "") + "\n");
  lines.push(`**pass@1 ${pct(s.passAt1)}**` + (s.runsPerTask > 1 ? ` · pass^${s.runsPerTask} ${pct(s.passAllK)}` : "") + ` · total cost $${s.efficiency.totalCost.toFixed(4)}\n`);
  if (s.excludedRuns) lines.push(`${s.excludedRuns} run(s) hit a provider error (rate limit or outage) and are left out of the numbers below.\n`);
  lines.push(`## By category\n`);
  lines.push(table(["Category", "Tasks", "Pass rate"].concat(s.runsPerTask > 1 ? [`Passed all ${s.runsPerTask}`] : []),
    Object.entries(s.categories).map(([c, v]) => [c, v.tasks, pct(v.passRate)].concat(s.runsPerTask > 1 ? [`${v.allPassed}/${v.tasks}`] : []))));
  lines.push(`\n## Tasks\n`);
  lines.push(table(["Task", "Passed", "API calls", "Tokens", "Cost", "Seconds", "Why it failed"],
    s.tasks.map((t) => [t.id, `${t.passes}/${t.runs}`, fmt(t.apiCalls), fmt(t.tokens), `$${t.cost.toFixed(4)}`, fmt(t.seconds, 0), t.reasons.join("; ") || "–"])));
  const e = s.efficiency;
  const b = s.behaviour;
  lines.push(`\n## Efficiency (mean per run)\n`);
  lines.push(table(["API calls", "Tokens", "Cost", "Seconds", "Cost per pass", "Cache hit rate"],
    [[fmt(e.apiCalls), fmt(e.tokens), `$${e.cost.toFixed(4)}`, fmt(e.seconds, 0), Number.isFinite(e.costPerPass) ? `$${e.costPerPass.toFixed(4)}` : "–", pct(e.cacheHitRate)]]));
  lines.push(`\n## Behaviour\n`);
  lines.push(table(["Metric", "Value"], [
    ["Tool error rate", `${pct(b.toolErrorRate)} of ${b.toolCalls} calls`],
    ["Results by kind", Object.entries(b.resultKinds).map(([k, n]) => `${k} ${n}`).join(", ") || "–"],
    ["Shell commands that failed", b.failedCommands],
    ["Loop nudges", b.nudges],
    ["Compactions", b.compactions],
    ["Sub-agent runs", b.subagents],
    ["Ran tests after its last edit", pct(b.verificationRate)],
    ["Said done, hidden tests failed", `${b.falseDone} of ${b.codeRuns} code runs`],
    ["Commands declined by the eval policy", b.declinedByPolicy],
    ["Timeouts", b.timeouts],
  ]));
  return lines.join("\n") + "\n";
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tasks = loadTasks(opts.tasks);
  if (tasks.length === 0) throw new Error(`No tasks match "${opts.tasks}"`);

  const model = resolveModel(opts);
  if (opts.freeOnly) {
    if (!model || !model.endsWith(":free")) {
      throw new Error(`--free-only: the model is "${model ?? "not set"}", which is not a free model (its id must end in ":free"). Nothing was run.`);
    }
    opts.env.OPENROUTER_MODEL = model; // pin it, so nothing else can change it
    opts.maxCost = Math.min(opts.maxCost, 0);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const label = opts.label ?? stamp;
  const outDir = opts.out ? path.resolve(opts.out) : path.join(RESULTS_DIR, label);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "runs.jsonl"), "");

  const jobs = [];
  for (let run = 0; run < opts.runs; run++) for (const task of tasks) jobs.push({ task, run });
  console.log(`Running ${tasks.length} tasks × ${opts.runs} run(s) → ${path.relative(process.cwd(), outDir)}`);

  const runs = [];
  let next = 0;
  let spent = 0;
  let stopped = null;
  const worker = async () => {
    while (next < jobs.length && !stopped) {
      const { task, run } = jobs[next++];
      const r = await runOne(task, run, opts, outDir);
      runs.push(r);
      const mark = r.pass ? "✓" : "✗";
      console.log(`${mark} ${task.id} #${run + 1}  ${r.apiCalls} calls · $${r.cost.toFixed(4)} · ${Math.round(r.durationMs / 1000)}s${r.reasons.length ? `  (${r.reasons.join("; ")})` : ""}`);
      if (r.status === "fatal") throw new Error(`DevPilot could not start: ${r.reasons.join("; ")}`);
      spent += r.cost ?? 0;
      if (spent > opts.maxCost) {
        stopped = `total cost $${spent.toFixed(4)} passed the limit of $${opts.maxCost}`;
        console.error(`Stopping: ${stopped}.`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));

  const order = new Map(jobs.map((j, i) => [`${j.task.id}#${j.run + 1}`, i]));
  runs.sort((a, b) => order.get(`${a.task}#${a.run}`) - order.get(`${b.task}#${b.run}`));
  const summary = summarize(runs, {
    label,
    date: new Date().toISOString().slice(0, 10),
    model: model ?? runs.find((r) => r.model)?.model ?? "(from .env)",
    stoppedEarly: stopped,
    env: opts.env,
    approve: opts.approve,
  });
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  const markdown = renderSummary(summary);
  writeFileSync(path.join(outDir, "summary.md"), markdown);
  console.log(`\n${markdown}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`Eval failed: ${err.message}`);
    process.exit(1);
  });
}
