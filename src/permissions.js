import { color } from "./ui.js";

// Read-only tools run without asking. Tools that change things (edits,
// shell commands) call approve() first, which asks the user:
//
//   y         run it once
//   n         don't run it
//   a         run it, and don't ask again for the same `key` this session
//             (only offered when the request has a key and an alwaysLabel)
//   anything else: don't run it, and pass the text to the model as feedback
//
// `ask` is a function that prints a question and resolves to the typed answer.
// `signal` lets Ctrl+C cancel a pending question. A front end that has its
// own UI for approvals (VS Code) passes `askApproval(request, { canAlways },
// signal)` instead, which resolves to the same kind of answer: "y", "n",
// "a" or feedback text.
export function createPermissions({ ask, askApproval = null }) {
  const alwaysAllowed = new Set();

  // Sub-agents can run in parallel, and two of them may want permission at
  // the same moment. Questions wait in line, so the user sees one at a time.
  let queue = Promise.resolve();
  return function approve(request, signal) {
    const turn = queue.then(() => (signal?.aborted ? { allowed: false, message: "Cancelled by the user." } : prompt(request, signal)));
    queue = turn.catch(() => {});
    return turn;
  };

  async function prompt(request, signal) {
    const { key, title, preview, alwaysLabel } = request;
    const canAlways = Boolean(key && alwaysLabel);
    if (canAlways && alwaysAllowed.has(key)) {
      if (!askApproval && preview) console.log(`\n${preview}\n`);
      console.log(color.dim(`  ✓ ${title} (allowed for this session)`));
      return { allowed: true };
    }

    let answer;
    if (askApproval) {
      answer = String(await askApproval(request, { canAlways }, signal)).trim();
    } else {
      if (preview) console.log(`\n${preview}\n`);
      const options = canAlways ? `[y] yes  [n] no  [a] ${alwaysLabel}` : "[y] yes  [n] no";
      const question = `${color.yellow("?")} ${color.bold(title)}\n  ${options}  (or type feedback)\n  > `;
      answer = (await ask(question, signal)).trim();
    }
    const choice = answer.toLowerCase();

    if (choice === "y" || choice === "yes") return { allowed: true };
    if (canAlways && (choice === "a" || choice === "always")) {
      alwaysAllowed.add(key);
      return { allowed: true };
    }
    if (choice === "" || choice === "n" || choice === "no") {
      return { allowed: false, message: "The user declined this action. Ask them how to proceed." };
    }
    return {
      allowed: false,
      message: `The user declined this action and said: "${answer}"`,
    };
  }
}
