import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { deliverShellResponse } from "../../../overrides/infrastructure/deliver.js";
import type { HarnessRequest } from "../../domain/execution.js";
import { writeJson } from "./json-file.js";
import { connectMcpTools } from "./mcp-tools.js";
import { createResources } from "./resources.js";
import { webTool } from "./web.js";

export function sessionBash(request: HarnessRequest) {
  const runtime = request.runtime;
  const bash = createBashToolDefinition(request.workspace, {
    ...(runtime && { operations: { exec: runtime.shell.bind(runtime) } }),
    spawnHook(context) {
      delete context.env.TYPESAFE_API_KEY;
      return context;
    },
  });
  const rules = request.responseOverrides?.filter(
    (rule) => rule.target.kind === "shell",
  );
  if (!rules?.length || request.label === "judge") return bash;
  const execute = bash.execute;
  bash.execute = async (id, params, ...rest) => {
    const result = await execute(id, params, ...rest);
    // Pi returns one text block for the completed shell command, including any truncation notice.
    const block = result.content[0];
    if (block?.type === "text" && result.content.length === 1) {
      const text = await deliverShellResponse(
        rules,
        params.command,
        block.text,
        id,
        request.onToolResponse,
        request.rewrite,
      );
      return { ...result, content: [{ ...block, text }] };
    }
    return result;
  };
  return bash;
}

export async function createSession(request: HarnessRequest) {
  const agentDir = join(request.directory, "pi");

  await mkdir(agentDir, { recursive: true });

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });

  const resourceLoader = await createResources(
    request,
    agentDir,
    settingsManager,
  );

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  const model = modelRuntime.getModel("openrouter", request.model);

  if (request.apiKey)
    await modelRuntime.setRuntimeApiKey("openrouter", request.apiKey);

  if (!model) throw new Error(`Unknown OpenRouter model: ${request.model}`);

  const mcp = await connectMcpTools(request);
  const dockerTools: ToolDefinition[] =
    request.runtime?.kind === "docker"
      ? ([
          createReadToolDefinition(request.workspace),
          sessionBash(request),
          createEditToolDefinition(request.workspace),
          createWriteToolDefinition(request.workspace),
          createLsToolDefinition(request.workspace),
        ] as unknown as ToolDefinition[])
      : [];
  const selectedTools =
    request.runtime?.kind === "docker"
      ? request.tools.filter((tool) => tool !== "grep" && tool !== "find")
      : request.tools;

  const { session } = await createAgentSession({
    cwd: request.workspace,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel: request.effort,
    ...(dockerTools.length ? { noTools: "builtin" as const } : {}),
    tools: [...selectedTools, ...mcp.tools.map((tool) => tool.name)],
    customTools: [
      ...dockerTools,
      ...(request.runtime?.kind !== "docker" &&
      selectedTools.includes("bash") &&
      request.responseOverrides?.some((r) => r.target.kind === "shell")
        ? [sessionBash(request) as unknown as ToolDefinition]
        : []),
      ...(selectedTools.includes("web_fetch") ? [webTool(request)] : []),
      ...mcp.tools,
    ],
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.create(
      request.workspace,
      join(request.directory, "sessions"),
    ),
  }).catch(async (error: unknown) => {
    await mcp.close();

    throw error;
  });

  try {
    await writeJson(join(request.directory, "effective.json"), {
      model,
      effort: session.thinkingLevel,
      tools: session.getActiveToolNames(),
      toolSchemas: session
        .getAllTools()
        .filter((tool) => session.getActiveToolNames().includes(tool.name))
        .map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
      systemPrompt: session.systemPrompt,
      skills: resourceLoader.getSkills().skills,
      settings: settingsManager.getSettings(),
    });

    return Object.assign(session, { closeMcp: mcp.close });
  } catch (error) {
    session.dispose();

    await mcp.close();

    throw error;
  }
}
