// Decide what happens to a shell command before anyone is asked:
//
//   deny  -> never run it; the model gets the reason back
//   allow -> run it without a prompt (matches an allow rule in settings)
//   ask   -> show the normal y / n / always prompt
//
// This is a seat belt, not a sandbox. A determined model can always find a
// command we did not think of, which is why commands still need approval and
// why the Docker sandbox exists. The deny list catches the obvious disasters.

// A command "at the start of a segment": after the beginning, ; & | ( or sudo.
const at = (words) => new RegExp(`(^|[;&|(]\\s*|\\bsudo\\s+)(${words})\\b`, "i");

const BLOCKED = [
  {
    // rm with a recursive flag aimed at /, ~, $HOME, ., .., * or /*
    pattern:
      /\brm(?=[^;&|]*\s(?:-[a-zA-Z]*[rR]|--recursive))[^;&|]*?\s["']?(\/|~|~\/|\$HOME|\.|\.\.|\*|\/\*)["']?(?=\s|$|[;&|])/,
    reason: "it recursively deletes /, ~, the whole workspace or everything matching *",
  },
  { pattern: /\bmkfs(\.\w+)?\b/, reason: "it formats a disk" },
  { pattern: /\bdd\b[^;&|]*\bof=\/dev\//, reason: "it writes directly to a device" },
  { pattern: />\s*\/dev\/(sd|hd|nvme|disk)/, reason: "it overwrites a disk device" },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "it is a fork bomb" },
  { pattern: at("shutdown|reboot|halt|poweroff|Stop-Computer|Restart-Computer"), reason: "it shuts down or restarts the machine" },
  { pattern: /\bgit\s+push\b[^;&|]*\s(--force(?!-with-lease)|-f)(?=\s|$)/, reason: "it force-pushes and can destroy remote history" },
  {
    pattern: /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^;&]*\|\s*(sudo\s+)?((ba|z|da)?sh|iex|Invoke-Expression|python3?|node)\b/i,
    reason: "it downloads a script and runs it immediately",
  },
  { pattern: /\bchmod\s+(-R\s+)?777\s+\/(\s|$)/, reason: "it makes the whole filesystem writable by everyone" },
  {
    pattern: /\bRemove-Item\b(?=[^;|]*-Recurse)[^;|]*\s["']?([A-Za-z]:\\?|~|\$HOME|\$env:USERPROFILE)["']?(\s|$)/i,
    reason: "it recursively deletes a drive or the home folder",
  },
  { pattern: /\b(Format-Volume|Clear-Disk)\b/i, reason: "it formats a disk" },
  { pattern: /(^|[;&|]\s*)format\s+[a-z]:/i, reason: "it formats a disk" },
  { pattern: /\b(rd|rmdir)\s+\/s\b[^;&|]*\s[a-z]:\\?(\s|$)/i, reason: "it deletes a whole drive" },
  {
    // Tier 1 protects .env from the file tools; this closes the shell back door.
    pattern: /(^|[\s"'=/\\<>])\.env(\.[\w.-]+)?(?=$|[\s"';|&)])/,
    reason: "it touches a .env file, which holds secrets",
  },
];

// Split on the operators that chain commands: && || ; | and newlines.
export function splitCommand(command) {
  return command
    .split(/&&|\|\||;|\||\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

// "Simple" = one command, no chaining, piping, redirects or substitution.
// Only simple commands may be auto-allowed, otherwise an allow rule for
// `npm test` would also allow `npm test && rm -rf src`.
export function isSimpleCommand(command) {
  return !/[;&|`<>\n]|\$\(/.test(command);
}

function startsWithRule(segment, rule) {
  return segment === rule || segment.startsWith(`${rule} `);
}

export function checkCommand(command, settings = { allow: [], deny: [] }) {
  for (const { pattern, reason } of BLOCKED) {
    if (pattern.test(command)) return { verdict: "deny", reason };
  }

  for (const segment of splitCommand(command)) {
    const rule = settings.deny.find((r) => startsWithRule(segment, r));
    if (rule) return { verdict: "deny", reason: `"${rule}" is on the deny list in .devpilot/settings.json` };
  }

  const trimmed = command.trim();
  if (isSimpleCommand(trimmed)) {
    const rule = settings.allow.find((r) => startsWithRule(trimmed, r));
    if (rule) return { verdict: "allow", reason: `matches allow rule "${rule}"` };
  }

  return { verdict: "ask" };
}
