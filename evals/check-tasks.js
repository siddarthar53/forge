#!/usr/bin/env node
// Check the eval tasks themselves (no model needed): every task's hidden
// tests must FAIL on the untouched repo and PASS with the reference solution.
// Run it after adding or changing a task, so a broken task is never blamed on
// the agent.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { hiddenTestFiles, loadTasks, prepareWorkspace } from "./lib/tasks.js";

function hiddenPass(task, withSolution) {
  const ws = prepareWorkspace(task, { withSolution });
  cpSync(path.join(task.dir, "hidden"), path.join(ws.work, "__hidden__"), { recursive: true });
  const result = spawnSync(process.execPath, ["--test", ...hiddenTestFiles(path.join(task.dir, "hidden"))], { cwd: ws.work, encoding: "utf8", timeout: 60_000 });
  rmSync(ws.root, { recursive: true, force: true });
  return result.status === 0;
}

let problems = 0;
for (const task of loadTasks()) {
  if (!existsSync(path.join(task.dir, "hidden"))) {
    console.log(`·  ${task.id}: graded by ${task.check?.type ?? "none"}, no hidden tests`);
    continue;
  }
  const before = hiddenPass(task, false);
  const after = existsSync(path.join(task.dir, "solution")) ? hiddenPass(task, true) : null;
  const ok = !before && after !== false;
  if (!ok) problems++;
  console.log(`${ok ? "✓" : "✗"}  ${task.id}: hidden tests ${before ? "PASS" : "fail"} before, ${after === null ? "no solution" : after ? "pass" : "FAIL"} with the solution`);
}
if (problems) {
  console.error(`\n${problems} task(s) need fixing.`);
  process.exit(1);
}
console.log("\nAll tasks are valid.");
