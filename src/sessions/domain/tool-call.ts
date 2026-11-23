// Harness events can report the input and output in separate messages.
interface CallUpdate {
  id: string;
  name?: string;
  server?: string;
  input?: unknown;
  output?: unknown;
  status: "running" | "completed" | "failed";
}
export const asObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const responseIdKey = "stunthog/responseId";
export function toolResponseId(result: unknown): string | undefined {
  const metadata = asObject(asObject(result)._meta);
  const id = metadata[responseIdKey] ?? metadata["agent-eval/responseId"];
  return typeof id === "string" ? id : undefined;
}
const str = (value: unknown) => (typeof value === "string" ? value : "");
export function callUpdates(raw: unknown): CallUpdate[] {
  const event = asObject(raw);
  const message = asObject(event.message);
  const part = asObject(event.part);
  const item = asObject(event.item);
  if (
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_end"
  ) {
    const id = str(event.toolCallId);
    return id
      ? [
          {
            id,
            name: str(event.toolName),
            input: event.args,
            output: event.result,
            status:
              event.type === "tool_execution_start"
                ? "running"
                : event.isError
                  ? "failed"
                  : "completed",
          },
        ]
      : [];
  }
  if (["message_end", "assistant", "user"].includes(str(event.type))) {
    if (message.role === "toolResult" && str(message.toolCallId))
      return [
        {
          id: str(message.toolCallId),
          name: str(message.toolName),
          output: { content: message.content, details: message.details },
          status: message.isError ? "failed" : "completed",
        },
      ];
    return (Array.isArray(message.content) ? message.content : []).flatMap(
      (block): CallUpdate[] => {
        const b = asObject(block);
        if (
          ["toolCall", "tool_use", "server_tool_use", "mcp_tool_use"].includes(
            str(b.type),
          ) &&
          str(b.id)
        )
          return [
            {
              id: str(b.id),
              name: str(b.name),
              server: str(b.server_name),
              input: b.input ?? b.arguments,
              status: "running",
            },
          ];
        if (
          str(b.tool_use_id) &&
          (b.type === "tool_result" || str(b.type).endsWith("_tool_result"))
        )
          return [
            {
              id: str(b.tool_use_id),
              output: b.content,
              status:
                b.is_error || str(asObject(b.content).type).endsWith("_error")
                  ? "failed"
                  : "completed",
            },
          ];
        return [];
      },
    );
  }
  if (part.type === "tool" || event.type === "tool_use") {
    const state = asObject(part.state);
    const id = str(part.callID ?? part.id);
    return id
      ? [
          {
            id,
            name: str(part.tool),
            input: state.input,
            output: state.output ?? state.error,
            status:
              state.status === "completed"
                ? "completed"
                : state.status === "error"
                  ? "failed"
                  : "running",
          },
        ]
      : [];
  }
  if (!str(event.type).startsWith("item.") || !str(item.id)) return [];
  const type = str(item.type);
  if (
    ![
      "command_execution",
      "file_change",
      "web_search",
      "image_generation",
    ].includes(type) &&
    !type.endsWith("tool_call")
  )
    return [];
  const status =
    item.status === "failed" ||
    item.error ||
    (typeof item.exit_code === "number" && item.exit_code !== 0)
      ? "failed"
      : event.type === "item.completed"
        ? "completed"
        : "running";
  const output =
    item.result ??
    item.error ??
    item.output ??
    item.aggregated_output ??
    item.agents_states ??
    item.content_items ??
    (type === "file_change" && status !== "running" ? item.changes : undefined);
  return [
    {
      id: str(item.id),
      name: str(item.tool) || type,
      server: str(item.server),
      input:
        item.arguments ??
        item.input ??
        item.prompt ??
        (item.command !== undefined
          ? { command: item.command }
          : (item.action ??
            (item.query !== undefined ? { query: item.query } : item.changes))),
      output,
      status,
    },
  ];
}

export function identifyTool(name: string, server?: string | null) {
  const native = /^(?:mcp__)?eval_(\d+)_{1,2}(.+)$/.exec(name);
  const pi = /^mcp_(\d+)_\d+_(.+)$/.exec(name);
  const index =
    native?.[1] ?? pi?.[1] ?? /^eval_(\d+)$/.exec(server ?? "")?.[1];
  const tool = native?.[2] ?? pi?.[2] ?? name;
  const source =
    index !== undefined || server || name.startsWith("mcp__")
      ? "mcp"
      : /^(web_fetch|webfetch)$/i.test(name)
        ? "web"
        : "native";
  return {
    tool,
    source,
    index: index === undefined ? undefined : Number(index),
  };
}
