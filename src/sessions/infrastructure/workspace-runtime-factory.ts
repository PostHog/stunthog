import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { Injectable } from "@nestjs/common";
import type {
  HarnessRuntime,
  ProcessCommand,
  ShellOptions,
} from "../../harnesses/domain/execution.js";
import type { HarnessId } from "../../harnesses/domain/harness.js";
import type { ExecutionSnapshot } from "../domain/execution-snapshot.js";
import { WorkspaceRuntimeFactory } from "../domain/workspace-runtime.js";
import { contains } from "./workspace-files.js";

class LocalWorkspaceRuntime implements HarnessRuntime {
  readonly kind = "local" as const;
  private readonly bash = createLocalBashOperations();

  async process(command: ProcessCommand): Promise<ProcessCommand> {
    return command;
  }

  shell(command: string, cwd: string, options: ShellOptions) {
    return this.bash.exec(command, cwd, options);
  }

  async close(): Promise<void> {}
}

class DockerWorkspaceRuntime implements HarnessRuntime {
  readonly kind = "docker" as const;
  private environmentFileIndex = 0;

  private constructor(
    private readonly root: string,
    private readonly container: string,
    readonly imageId: string,
  ) {}

  static async start(
    root: string,
    dockerfilePath: string | null,
    dockerfileContent: string | null,
    harness: HarnessId,
    signal: AbortSignal,
    restoredImage?: string,
  ) {
    const image =
      restoredImage ??
      (await buildDockerImage(
        root,
        dockerfilePath,
        dockerfileContent,
        harness,
        signal,
      ));
    if (!image) throw new Error("Docker did not return an image ID.");

    const container = (
      await control(
        [
          "run",
          "--detach",
          "--rm",
          ...(restoredImage ? ["--pull=never"] : []),
          "--mount",
          `type=bind,source=${root},target=/stunthog`,
          "--workdir",
          "/stunthog/workspace",
          image,
          "sh",
          "-c",
          "while :; do sleep 3600; done",
        ],
        signal,
      )
    ).trim();

    if (!container) throw new Error("Docker did not return a container ID.");

    return new DockerWorkspaceRuntime(root, container, image);
  }

  async process(command: ProcessCommand, cwd: string): Promise<ProcessCommand> {
    const environmentArgs = await this.environmentArguments(command.env, true);

    return {
      binary: "docker",
      args: [
        "exec",
        "--interactive",
        "--workdir",
        this.filePath(cwd),
        ...environmentArgs,
        this.container,
        this.map(command.binary),
        ...command.args.map((argument) => this.map(argument)),
      ],
      env: process.env,
    };
  }

  async shell(command: string, cwd: string, options: ShellOptions) {
    const environmentArgs = await this.environmentArguments(options.env);

    return stream(
      [
        "exec",
        "--interactive",
        "--workdir",
        this.filePath(cwd),
        ...environmentArgs,
        this.container,
        "sh",
        "-lc",
        this.map(command),
      ],
      options,
    );
  }

  async close(): Promise<void> {
    await control(["rm", "--force", this.container]).catch(() => undefined);
  }

  filePath(path: string): string {
    const absolute = resolve(path);

    if (!contains(this.root, absolute))
      throw new Error(`The runtime path is outside the session: ${path}`);

    const suffix = relative(this.root, absolute).split(sep).filter(Boolean);

    return ["/stunthog", ...suffix].join("/");
  }

  private map(value: string): string {
    return value.replaceAll(this.root, "/stunthog");
  }

  private async environmentArguments(
    environment: NodeJS.ProcessEnv = {},
    explicit = false,
  ) {
    const entries = Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        (explicit || process.env[entry[0]] !== entry[1]),
    );

    return entries.length
      ? ["--env-file", await this.environmentFile(entries)]
      : [];
  }

  private async environmentFile(entries: [string, string][]) {
    const path = resolve(
      this.root,
      `.docker-env-${this.environmentFileIndex++}`,
    );

    for (const [name, value] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /[\r\n]/.test(value))
        throw new Error(
          `Cannot pass the environment variable to Docker: ${name}`,
        );
    }

    await writeFile(
      path,
      `${entries.map(([name, value]) => `${name}=${value}`).join("\n")}\n`,
      { mode: 0o600 },
    );

    return path;
  }
}

@Injectable()
export class DefaultWorkspaceRuntimeFactory extends WorkspaceRuntimeFactory {
  async create(
    environment: ExecutionSnapshot["environment"],
    root: string,
    _workspace: string,
    signal: AbortSignal,
    harness: HarnessId,
  ): Promise<HarnessRuntime> {
    if (environment?.executionMode !== "docker")
      return new LocalWorkspaceRuntime();

    if (
      !environment.restoredImage &&
      !environment.dockerfilePath &&
      !environment.dockerfileContent
    )
      throw new Error(
        "The Docker environment has no Dockerfile configuration.",
      );

    await mkdir(root, { recursive: true });

    return DockerWorkspaceRuntime.start(
      root,
      environment.dockerfilePath,
      environment.dockerfileContent,
      harness,
      signal,
      environment.restoredImage,
    );
  }
}

const harnessPackages: Partial<Record<HarnessId, string>> = {
  claude: "@anthropic-ai/claude-code@2.1.325",
  codex: "@openai/codex@0.169.0",
  opencode: "opencode-ai@1.19.5",
};

async function buildDockerImage(
  root: string,
  dockerfilePath: string | null,
  dockerfileContent: string | null,
  harness: HarnessId,
  signal: AbortSignal,
) {
  const build = await prepareDockerBuild(
    root,
    dockerfilePath,
    dockerfileContent,
    harness,
  );
  return (
    await control(
      ["build", "--quiet", "--file", build.dockerfile, build.context],
      signal,
    )
  ).trim();
}

async function prepareDockerBuild(
  root: string,
  dockerfilePath: string | null,
  dockerfileContent: string | null,
  harness: HarnessId,
) {
  const directory = resolve(root, "docker-build");
  const path = resolve(directory, "Dockerfile");
  const sourcePath = dockerfilePath ? resolve(dockerfilePath) : null;
  const content = sourcePath
    ? await readFile(sourcePath, "utf8")
    : (dockerfileContent ?? "");
  const harnessPackage = harnessPackages[harness];

  await mkdir(directory, { recursive: true });
  await writeFile(
    path,
    harnessPackage
      ? `${content.trimEnd()}\n\nRUN npm install --global ${harnessPackage}\n`
      : content,
    { mode: 0o600 },
  );

  return {
    dockerfile: path,
    context: sourcePath ? dirname(sourcePath) : directory,
  };
}

function control(args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const abort = () => child.kill();

    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);

      if (signal?.aborted) reject(signal.reason);
      else if (code === 0) resolveCommand(Buffer.concat(stdout).toString());
      else
        reject(
          new Error(
            `Docker exited with code ${code}: ${Buffer.concat(stderr).toString().trim()}`,
          ),
        );
    });
  });
}

function stream(args: string[], options: ShellOptions) {
  return new Promise<{ exitCode: number | null }>((resolveCommand, reject) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    const stop = () => child.kill();
    const timer = options.timeout
      ? setTimeout(() => {
          timedOut = true;
          stop();
        }, options.timeout * 1000)
      : undefined;

    options.signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", options.onData);
    child.stderr.on("data", options.onData);
    child.once("error", reject);
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);

      if (options.signal?.aborted) reject(options.signal.reason);
      else if (timedOut)
        reject(new Error(`Command timed out after ${options.timeout}s.`));
      else resolveCommand({ exitCode: code });
    });
  });
}
