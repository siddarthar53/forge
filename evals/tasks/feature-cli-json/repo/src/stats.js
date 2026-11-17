export function stats(text) {
  return {
    lines: text === "" ? 0 : text.split("\n").length,
    words: text.split(/\s+/).filter(Boolean).length,
    chars: text.length,
  };
}
