import type { Target } from "./response-override.js";

export const maxFindLength = 2048;
export const maxReplacementLength = 16000;
export const maxPathLength = 512;

type TextField = { text: string; path: string };

function* structuredFields(value: unknown, path: string): Generator<TextField> {
  if (path.length > maxPathLength) return;
  if (typeof value === "string" && value && path) yield { text: value, path };
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const part = key.replaceAll("~", "~0").replaceAll("/", "~1");
      yield* structuredFields(child, `${path}/${part}`);
    }
  }
}

function* editableFields(
  original: unknown,
  target?: Target,
): Generator<TextField> {
  if (target?.kind !== "mcp" || typeof original === "string") {
    const text =
      typeof original === "string"
        ? original
        : JSON.stringify(original, null, 2);
    if (text) yield { text, path: "" };
    return;
  }
  if (!original || typeof original !== "object") return;
  // The runtime replaces text inside each MCP block separately.
  if ("content" in original && Array.isArray(original.content)) {
    for (const block of original.content) {
      if (
        block?.type === "text" &&
        typeof block.text === "string" &&
        block.text
      )
        yield { text: block.text, path: "" };
    }
  }
  if ("structuredContent" in original)
    yield* structuredFields(original.structuredContent, "");
}

// A single text field can be edited as a document. Compound responses use a matching rule.
export function singlePassage(original: unknown, target?: Target) {
  const fields = editableFields(original, target);
  const first = fields.next();
  return !first.done && fields.next().done ? first.value : undefined;
}

export function editFromSample(
  original: unknown,
  target?: Target,
  selection = "",
) {
  let first: TextField | undefined;
  for (const field of editableFields(original, target)) {
    first ??= field;
    if (!selection) break;
    if (field.text.includes(selection)) {
      first = { text: selection, path: field.path };
      break;
    }
  }
  const text = first?.text ?? "";
  const find =
    text.length <= maxFindLength
      ? text
      : text.slice(0, maxFindLength).replace(/[\uD800-\uDBFF]$/u, "");
  return { find, replacement: find, path: first?.path ?? "" };
}

// Use the changed lines as the rule so unrelated parts of the response can change between calls.
export function literalEdit(before: string, after: string) {
  if (before === after) return { find: "", replacement: "" };
  let start = 0;
  while (start < before.length && before[start] === after[start]) start++;
  let end = before.length;
  let tail = after.length;
  while (end > start && tail > start && before[end - 1] === after[tail - 1]) {
    end--;
    tail--;
  }

  const lineStart = before.slice(0, start).lastIndexOf("\n") + 1;
  const nextBreak = before.indexOf("\n", end);
  const lineEnd = nextBreak < 0 ? before.length : nextBreak;
  function candidate(left: number, right: number) {
    const find = before.slice(left, right);
    if (!find || find.length > maxFindLength) return;
    if (before.indexOf(find) !== before.lastIndexOf(find)) return;
    const replacement = after.slice(
      left,
      after.length - (before.length - right),
    );
    if (replacement.length <= maxReplacementLength)
      return { find, replacement };
  }
  const line = candidate(lineStart, lineEnd);
  if (line) return line;
  // Repeated lines and insertions need context to identify the intended occurrence.
  for (
    let context = 0;
    context <= maxFindLength;
    context = context ? context * 2 : 1
  ) {
    let left = Math.max(0, start - context);
    let right = Math.min(before.length, end + context);
    if (left && /[\uDC00-\uDFFF]/u.test(before.charAt(left))) left--;
    if (/[\uD800-\uDBFF]/u.test(before.charAt(right - 1))) right++;
    const edit = candidate(left, right);
    if (edit) return edit;
    if (
      right - left >= maxFindLength ||
      (left === 0 && right === before.length)
    )
      break;
  }
}
