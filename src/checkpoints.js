import { promises as fs } from "node:fs";

// Checkpoints make /undo possible.
//
// Each user turn starts a checkpoint. Before the first change to a file in
// that turn, we save the file's old bytes (or `null` if it did not exist).
// /undo walks back one turn: it puts every saved file back (deleting files
// that turn created) and cuts the conversation back to before the turn.
//
// Limits, on purpose: changes made by shell commands (npm install, git, a
// script that writes files) are not tracked. Checkpoints live in memory, so
// they do not survive a restart. Git commits are the long-term safety net.
export function createCheckpoints() {
  const turns = [];

  return {
    // messageIndex: history length before the turn's user message, so the
    // conversation can be cut back to exactly that point.
    begin({ messageIndex, prompt }) {
      turns.push({ messageIndex, prompt, files: new Map() });
    },

    // Called by the file tools right before they write `absolute`.
    async record(absolute) {
      const turn = turns.at(-1);
      if (!turn || turn.files.has(absolute)) return; // keep the oldest version

      let previous = null;
      try {
        previous = await fs.readFile(absolute); // a Buffer: exact bytes, any encoding
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
      turn.files.set(absolute, previous);
    },

    // Compaction and /clear rewrite history, so old message indexes are
    // meaningless. Undo then restores files but leaves the conversation alone.
    historyWasReset() {
      for (const turn of turns) turn.messageIndex = null;
    },

    async undoLast() {
      const turn = turns.pop();
      if (!turn) return null;

      const restored = [];
      for (const [absolute, previous] of turn.files) {
        if (previous === null) await fs.rm(absolute, { force: true });
        else await fs.writeFile(absolute, previous);
        restored.push({ absolute, deleted: previous === null });
      }
      return { prompt: turn.prompt, messageIndex: turn.messageIndex, restored };
    },

    clear() {
      turns.length = 0;
    },

    get count() {
      return turns.length;
    },
  };
}
