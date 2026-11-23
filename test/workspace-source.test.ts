import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { prepareWorkspaceSource } from "../src/sessions/infrastructure/workspace-source.js";

const execute = promisify(execFile);

test("a repository environment clones an independent workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "stunthog-repository-"));
  const source = join(root, "source");
  const target = join(root, "target");

  try {
    await execute("git", ["init", source]);
    await execute("git", [
      "-C",
      source,
      "config",
      "user.email",
      "test@example.com",
    ]);
    await execute("git", ["-C", source, "config", "user.name", "Test"]);
    await writeFile(join(source, "app.ts"), "original");
    await execute("git", ["-C", source, "add", "app.ts"]);
    await execute("git", ["-C", source, "commit", "-m", "Initial"]);

    await prepareWorkspaceSource(
      {
        title: "Repository",
        workspacePath: null,
        repositoryUrl: source,
        executionMode: "local",
        dockerfilePath: null,
        dockerfileContent: null,
      },
      target,
      [],
    );
    await writeFile(join(target, "app.ts"), "changed");

    assert.equal(await readFile(join(source, "app.ts"), "utf8"), "original");
    assert.equal(await readFile(join(target, "app.ts"), "utf8"), "changed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
