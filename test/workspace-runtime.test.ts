import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { ModelSettings } from "../src/evaluations/domain/model-settings.js";
import { externalCommand } from "../src/harnesses/infrastructure/external-command.js";
import { DefaultWorkspaceRuntimeFactory } from "../src/sessions/infrastructure/workspace-runtime-factory.js";

test(
  "a Docker runtime routes processes and shell commands through one container",
  {
    skip:
      process.platform === "win32" ? "Requires a Unix Docker fixture." : false,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "stunthog-docker-"));
    const bin = join(root, "bin");
    const workspace = join(root, "workspace");
    const dockerfile = join(root, "Dockerfile");
    const log = join(root, "docker.log");
    const previousPath = process.env.PATH;
    const previousKey = process.env.ANTHROPIC_API_KEY;
    const previousLog = process.env.STUNTHOG_DOCKER_LOG;

    try {
      await mkdir(bin);
      await mkdir(workspace);
      await writeFile(dockerfile, "FROM scratch\n");
      await writeFile(
        join(bin, "docker"),
        '#!/bin/sh\necho "$@" >> "$STUNTHOG_DOCKER_LOG"\ncase "$1" in\n  build) echo sha256:test ;;\n  run) echo container-test ;;\nesac\n',
      );
      await chmod(join(bin, "docker"), 0o700);
      process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
      process.env.STUNTHOG_DOCKER_LOG = log;
      const key = "anthropic-fixture-key";
      process.env.ANTHROPIC_API_KEY = key;

      const runtime = await new DefaultWorkspaceRuntimeFactory().create(
        {
          title: "Docker",
          workspacePath: null,
          repositoryUrl: null,
          executionMode: "docker",
          dockerfilePath: dockerfile,
          dockerfileContent: null,
        },
        root,
        workspace,
        new AbortController().signal,
        "codex",
      );
      const command = await runtime.process(
        {
          binary: "hog",
          args: ["--version"],
          env: { HOG_TEST_KEY: "secret" },
        },
        workspace,
      );

      assert.equal(runtime.kind, "docker");
      assert.equal(command.binary, "docker");
      assert.deepEqual(command.args.slice(0, 5), [
        "exec",
        "--interactive",
        "--workdir",
        "/stunthog/workspace",
        "--env-file",
      ]);
      assert.deepEqual(command.args.slice(-3), [
        "container-test",
        "hog",
        "--version",
      ]);
      assert.match(
        await readFile(command.args[5] ?? "", "utf8"),
        /HOG_TEST_KEY=secret/,
      );
      assert.match(
        await readFile(join(root, "docker-build", "Dockerfile"), "utf8"),
        /RUN npm install --global @openai\/codex@0\.169\.0/,
      );

      const claude = await externalCommand("claude", {
        label: "agent",
        settings: ModelSettings.create({ model: "claude-sonnet" }).value,
        model: "claude-sonnet",
        effort: "low",
        directory: root,
        workspace,
        prompt: "Test",
        skills: [],
        tools: [],
        timeout: 10,
        maxTurns: 1,
        signal: new AbortController().signal,
        onRawEvent: async () => {},
        apiKey: key,
        runtime,
      });
      const dockerClaude = await runtime.process(claude, workspace);
      const envFile =
        dockerClaude.args[dockerClaude.args.indexOf("--env-file") + 1];
      assert.ok(envFile);
      assert.equal(
        await readFile(envFile, "utf8"),
        `ANTHROPIC_API_KEY=${key}\n`,
      );
      assert.ok(!dockerClaude.args.join(" ").includes(key));

      await runtime.shell("hog --version", workspace, {
        onData: () => {},
        env: { ...process.env, HOG_SHELL_KEY: "shell-secret" },
      });
      await runtime.close();

      const inline = await new DefaultWorkspaceRuntimeFactory().create(
        {
          title: "Inline Dockerfile",
          workspacePath: null,
          repositoryUrl: null,
          executionMode: "docker",
          dockerfilePath: null,
          dockerfileContent: "FROM scratch\n",
        },
        root,
        workspace,
        new AbortController().signal,
        "pi",
      );

      assert.equal(
        await readFile(join(root, "docker-build", "Dockerfile"), "utf8"),
        "FROM scratch\n",
      );
      await inline.close();

      const openCode = await new DefaultWorkspaceRuntimeFactory().create(
        {
          title: "OpenCode Dockerfile",
          workspacePath: null,
          repositoryUrl: null,
          executionMode: "docker",
          dockerfilePath: dockerfile,
          dockerfileContent: null,
        },
        root,
        workspace,
        new AbortController().signal,
        "opencode",
      );

      assert.match(
        await readFile(join(root, "docker-build", "Dockerfile"), "utf8"),
        /RUN npm install --global opencode-ai@1\.19\.5/,
      );
      await openCode.close();

      const calls = await readFile(log, "utf8");

      assert.match(calls, /build --quiet --file/);
      assert.match(calls, /run --detach --rm/);
      assert.match(
        calls,
        /exec --interactive --workdir \/stunthog\/workspace --env-file/,
      );
      assert.match(calls, /rm --force container-test/);
      assert.ok(runtime.imageId);
      const branch = await new DefaultWorkspaceRuntimeFactory().create(
        {
          title: "Saved image",
          executionMode: "docker",
          workspacePath: null,
          repositoryUrl: null,
          dockerfilePath: null,
          dockerfileContent: null,
          restoredImage: runtime.imageId,
        },
        root,
        workspace,
        new AbortController().signal,
        "codex",
      );
      await branch.close();
      const restoreCalls = (await readFile(log, "utf8")).slice(calls.length);
      assert.doesNotMatch(restoreCalls, /build --quiet/);
      assert.match(restoreCalls, /--pull=never .*sha256:test/);
    } finally {
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousKey;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousLog === undefined) delete process.env.STUNTHOG_DOCKER_LOG;
      else process.env.STUNTHOG_DOCKER_LOG = previousLog;
      await rm(root, { recursive: true, force: true });
    }
  },
);
