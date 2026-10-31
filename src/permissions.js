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
// `signal` lets Ctrl+C cancel a pending question.
export function createPermissions({ ask }) {
  const alwaysAllowed = new Set();

  return async function approve({ key, title, preview, alwaysLabel }, signal) {
    if (preview) console.log(`\n${preview}\n`);

    const canAlways = Boolean(key && alwaysLabel);
    if (canAlways && alwaysAllowed.has(key)) {
      console.log(color.dim(`  ✓ ${title} (allowed for this session)`));
      return { allowed: true };
    }

    const options = canAlways ? `[y] yes  [n] no  [a] ${alwaysLabel}` : "[y] yes  [n] no";
    const question = `${color.yellow("?")} ${color.bold(title)}\n  ${options}  (or type feedback)\n  > `;
    const answer = (await ask(question, signal)).trim();
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
  };
}
