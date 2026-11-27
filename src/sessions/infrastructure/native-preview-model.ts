import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Inject, Injectable } from "@nestjs/common";
import {
  CredentialStore,
  type Provider,
  providers,
} from "../../credentials/provider.js";
import {
  catalogRuntime,
  providerModels,
} from "../../harnesses/infrastructure/model-catalog.js";
import { PreviewModel } from "../application/preview-session.js";
import type { PreviewMessage, PreviewReply } from "../domain/trace-edit.js";

type Context = Parameters<ModelRuntime["completeSimple"]>[1];
type Model = Parameters<ModelRuntime["completeSimple"]>[0];
const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function previewContext(
  model: Pick<Model, "api" | "provider" | "id">,
  history: PreviewMessage[],
  tools: Context["tools"],
): Context {
  const messages: Context["messages"] = [];
  const names = new Map<string, string>();
  let systemPrompt = "";
  for (const [timestamp, m] of history.entries()) {
    const content = m.content ?? "";
    if (m.role === "system") systemPrompt = content;
    else if (m.role === "user")
      messages.push({ role: "user", content, timestamp });
    else if (m.role === "assistant") {
      const calls = (m.tool_calls ?? []).map((call) => {
        names.set(call.id, call.function.name);
        return {
          type: "toolCall" as const,
          id: call.id,
          name: call.function.name,
          arguments: JSON.parse(call.function.arguments),
        };
      });
      messages.push({
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [
          ...(content ? [{ type: "text" as const, text: content }] : []),
          ...calls,
        ],
        timestamp,
        usage: emptyUsage,
        stopReason: calls.length ? "toolUse" : "stop",
      });
    } else {
      const toolCallId = m.tool_call_id ?? "";
      const toolName = names.get(toolCallId);
      if (!toolName)
        throw new Error("This trace lacks the matching tool call.");
      messages.push({
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text: content }],
        timestamp,
        isError: m.isError ?? false,
      });
    }
  }
  return {
    messages,
    ...(tools?.length && { tools }),
    ...(systemPrompt && { systemPrompt }),
  };
}

@Injectable()
export class NativePreviewModel extends PreviewModel {
  constructor(@Inject(CredentialStore) private readonly keys: CredentialStore) {
    super();
  }
  models(provider: Provider) {
    return providerModels(provider);
  }
  async next(
    ...[provider, id, messages, tools, signal]: Parameters<PreviewModel["next"]>
  ): Promise<PreviewReply> {
    const runtime = await catalogRuntime();
    const model = runtime.getModel(provider, id);
    if (!model) throw new Error("Choose a model from the preview catalog.");
    const apiKey = await this.keys.read(provider);
    if (!apiKey) throw new Error(`Add the ${provider} key in API keys.`);
    const context = previewContext(model, messages, tools);
    const payload = JSON.stringify(context);
    const stored = await Promise.all(
      (Object.keys(providers) as Provider[]).map((p) => this.keys.read(p)),
    );
    if (
      [
        ...stored,
        ...Object.values(providers).map((name) => process.env[name]),
      ].some((secret) => secret && payload.includes(secret))
    )
      throw new Error("Remove the provider key from the preview.");
    // Ask the provider for a single action. No harness, tool handler, or judge receives this response.
    const reply = await runtime
      .completeSimple(model, context, { apiKey, signal, maxRetries: 0 })
      .catch(() => {
        throw new Error("The provider could not complete the preview.");
      });
    if (reply.stopReason !== "stop" && reply.stopReason !== "toolUse")
      throw new Error("The provider did not return a complete preview.");
    const text = reply.content
      .flatMap((block) =>
        block.type === "text"
          ? [block.text]
          : block.type === "toolCall"
            ? [`${block.name} ${JSON.stringify(block.arguments)}`]
            : [],
      )
      .join("\n");
    if (!text) throw new Error("The model returned an empty preview.");
    return {
      action: {
        kind: reply.content.some((b) => b.type === "toolCall")
          ? "tool"
          : "message",
        text,
      },
      model: reply.responseModel ?? reply.model,
      tokens: reply.usage.totalTokens || null,
      cost: reply.usage.cost.total || null,
    };
  }
}
