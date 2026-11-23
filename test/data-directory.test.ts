import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("data directory defaults to the same home location from different projects and permits explicit overrides", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "stunthog-path-")));
  const moduleUrl = new URL(
    "../src/infrastructure/data-directory.ts",
    import.meta.url,
  ).href;

  function directoryFrom(
    cwd: string,
    configured = "",
    explicit?: string,
    previousSetting = "",
  ) {
    const result = spawnSync(
      process.execPath,
      [
        "--eval",
        `
      import { resolveDataDirectory } from ${JSON.stringify(moduleUrl)};
      console.log(resolveDataDirectory(${JSON.stringify(explicit)}));
    `,
      ],
      {
        cwd,
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          STUNTHOG_DATA_DIR: configured,
          AGENT_EVAL_DATA_DIR: previousSetting,
        },
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }

  try {
    const first = join(root, "first");
    const second = join(root, "second");
    await mkdir(first);
    await mkdir(second);

    const current = join(root, ".stunthog");
    const previous = join(root, ".agent-eval");
    assert.equal(directoryFrom(first), current);
    assert.equal(directoryFrom(second), directoryFrom(first));
    await mkdir(current);
    await mkdir(previous);
    await writeFile(join(previous, "agent-eval_dev.db"), "");
    assert.equal(directoryFrom(first), previous);
    await writeFile(join(current, "stunthog_dev.db"), "");
    assert.equal(directoryFrom(first), current);
    assert.equal(directoryFrom(first, "", undefined, previous), previous);
    assert.equal(directoryFrom(first, root, undefined, previous), root);
    assert.equal(
      directoryFrom(second, root, "custom-data"),
      join(second, "custom-data"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
