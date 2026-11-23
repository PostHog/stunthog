import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareResponseTools } from "../../overrides/infrastructure/native-tools.js";
import type {
  Harness,
  HarnessInput,
  HarnessResult,
} from "../domain/harness.js";
import { redactEvent, redactText } from "../domain/redact-secrets.js";
import { externalCommand } from "./external-command.js";
import { summarizeEvents } from "./external-events.js";
import { providerModels } from "./model-catalog.js";
import { printNativeTrace } from "./native-trace.js";
import { runProcess } from "./process-runner.js";

export class ExternalHarness implements Harness {
  readonly supportsMcp = true;
  readonly binary: string;
  // OpenCode's judge config denies every permission, which also blocks MCP tools.
  // Codex keeps shell reads of host files even in its read-only sandbox, so a judge
  // steered by planted transcript text could send those files out through MCP tool arguments.
  readonly judgeSupportsMcp: boolean;

  constructor(
    readonly id: "codex" | "claude" | "opencode",
    readonly title: string,
    readonly provider: "openai" | "anthropic" | "openrouter",
  ) {
    this.binary = id;
    this.judgeSupportsMcp = id === "claude";
  }

  async run(input: HarnessInput): Promise<HarnessResult> {
    const started = performance.now();
    const events: unknown[] = [];
    let failure: string | undefined;
    let turn = 0;
    const secrets = [
      input.apiKey,
      ...(input.mcps ?? []).map((server) => server.accessToken),
    ].filter((secret): secret is string => Boolean(secret));

    let prepared: Awaited<ReturnType<typeof prepareResponseTools>> | undefined;
    try {
      prepared = await prepareResponseTools(input);
      const localCommand = await externalCommand(
        this.id,
        prepared.input,
        prepared.shellHook,
      );
      const command = input.runtime
        ? await input.runtime.process(localCommand, input.workspace)
        : localCommand;

      await writeFile(
        join(input.directory, "effective.json"),
        JSON.stringify(
          {
            harness: this.id,
            settings: input.settings,
            binary: command.binary,
            arguments: command.args,
          },
          null,
          2,
        ),
      );

      await runProcess(command, {
        ...input,
        prompt: `${input.persona ? `Persona:\n${input.persona}\n\n` : ""}${input.prompt}`,
        onRawEvent: async (event) => {
          event = redactEvent(event, secrets);
          events.push(event);
          await input.onRawEvent(event);

          const type =
            event && typeof event === "object" && "type" in event
              ? event.type
              : "";

          if (
            ["turn.started", "step_start", "assistant"].includes(String(type))
          )
            turn++;

          printNativeTrace(
            `${input.label} ${input.model} ${turn}/${input.maxTurns}`,
            event,
          );
        },
      });
    } catch (error) {
      failure = redactText(
        error instanceof Error ? error.message : String(error),
        secrets,
      );
    }

    await prepared?.finish();
    const result = summarizeEvents(events);
    const error =
      (result.error
        ? [result.error, failure].filter(Boolean).join("\n")
        : failure) ??
      (!result.text ? "The harness returned no final response." : undefined);

    return {
      label: input.label,
      model: input.model,
      status: error ? "failed" : "completed",
      text: result.text,
      durationMs: performance.now() - started,
      ...(error ? { error } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
    };
  }

  async models() {
    const models = await providerModels(this.provider);

    return models.map((model) => ({
      ...model,
      id: this.id === "opencode" ? `openrouter/${model.id}` : model.id,
    }));
  }
}
