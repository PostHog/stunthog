import { type Pos, parse, type Statement } from "@aliou/sh";

// A tool reports one result for a batch. Match the submitted commands without executing or expanding them.
export function shellCommands(script: string): string[] {
  if (!script || script.length > 64_000) return [];
  const choices = new Set<string>();
  function collect({ command }: Statement) {
    switch (command.type) {
      case "Pipeline":
        for (const item of command.commands) collect(item);
        break;
      case "Logical":
        collect(command.left);
        collect(command.right);
        break;
      case "Subshell":
      case "Block":
        for (const item of command.body) collect(item);
        break;
      case "IfClause":
        for (const item of [
          ...command.cond,
          ...command.then,
          ...(command.else ?? []),
        ])
          collect(item);
        break;
      case "WhileClause":
        for (const item of [...command.cond, ...command.body]) collect(item);
        break;
      case "ForClause":
        for (const item of command.body) collect(item);
        break;
      case "SimpleCommand": {
        const words = command.words ?? [];
        if (!words[0]) break;
        const raw = (part?: {
          pos?: Pos | undefined;
          end?: Pos | undefined;
        }) =>
          part?.pos && part.end
            ? script.slice(part.pos.offset, part.end.offset)
            : "";
        const parts = [...(command.assignments ?? []), ...words].map(raw);
        for (const redir of command.redirects ?? []) {
          if (
            ["<&", ">&"].includes(redir.op) &&
            /^(?:\d+-?|-)$/.test(raw(redir.target))
          )
            continue;
          // The target stops at the delimiter. A here-document body is data, even when it contains shell syntax.
          parts.push(raw({ pos: redir.pos, end: redir.target.end }));
        }
        const text = parts.join(" ");
        if (parts.every(Boolean) && text.length <= 8192) choices.add(text);
        break;
      }
    }
  }
  try {
    for (const item of parse(script).ast.body) collect(item);
  } catch {
    return [];
  }
  return [...choices];
}

// Codex adds the executable and login flags to the trace, but its hook receives the unwrapped input.
function recordedCommand(batch: string) {
  if (!/^(?:\S*\/)?(?:ba|z)?sh -[lc]*c[lc]* /.test(batch)) return batch;
  try {
    const [stmt, next] = parse(batch).ast.body;
    if (next || stmt?.command.type !== "SimpleCommand") return batch;
    const words = stmt.command.words;
    if (words?.length !== 3 || stmt.command.redirects?.length) return batch;
    let script = "";
    for (const part of words[2]?.parts ?? []) {
      if (part.type === "SglQuoted" || part.type === "Literal")
        script += part.value;
      else if (part.type === "DblQuoted") {
        for (const child of part.parts) {
          if (child.type !== "Literal") return batch;
          script += child.value.replace(/\\(["$`\\])/g, "$1");
        }
      } else return batch;
    }
    return script || batch;
  } catch {
    return batch;
  }
}

export function shellCallTarget(name: string, args: Record<string, unknown>) {
  const command = args.command ?? args.cmd;
  if (
    /^(bash|shell|exec_command|command_execution)$/i.test(name) &&
    typeof command === "string" &&
    command.trim() &&
    command.length <= 64_000
  )
    return {
      kind: "shell",
      match: "batch",
      command: (name === "command_execution"
        ? recordedCommand(command)
        : command
      ).trim(),
    } as const;
}
