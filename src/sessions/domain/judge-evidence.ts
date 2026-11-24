import { asObject } from "./tool-call.js";

const limit = 6000;
function excerpt(text: string, terms: string[]) {
  if (text.length <= limit) return text;
  const blocks = [text.slice(0, 2000)];
  const lower = text.toLowerCase();
  const spans = terms
    .map((term) => lower.indexOf(term, 2000))
    .filter((i) => i >= 2000 && i < text.length - 1600)
    .sort((a, b) => a - b);
  let end = 2000;
  for (const i of spans) {
    if (i < end || blocks.length >= 4) continue;
    const start = Math.max(end, i - 150);
    blocks.push(text.slice(start, start + 720));
    end = start + 720;
  }
  blocks.push(text.slice(-1600));
  return blocks.join("\n[… tool output omitted …]\n");
}
export function compactJudgeEvidence(evidence: string, criteria: string[]) {
  const terms = [
    ...new Set(
      criteria
        .join(" ")
        .toLowerCase()
        .match(/[a-z0-9_./-]{4,}/g) ?? [],
    ),
  ];
  function visit(value: unknown, tool = false): unknown {
    if (typeof value === "string") return tool ? excerpt(value, terms) : value;
    if (Array.isArray(value)) return value.map((child) => visit(child, tool));
    if (value === null || typeof value !== "object") return value;
    const obj = asObject(value);
    const result =
      tool || obj.role === "toolResult" || obj.type === "tool_result";
    return Object.fromEntries(
      Object.entries(obj).map(([key, child]) => [
        key,
        visit(
          child,
          result ||
            ["aggregated_output", "output", "stdout", "stderr"].includes(key) ||
            (key === "result" && obj.type === "tool_execution_end"),
        ),
      ]),
    );
  }
  try {
    return JSON.stringify(visit(JSON.parse(evidence)));
  } catch {
    return evidence;
  }
}
