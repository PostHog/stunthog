import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadEnvironment } from "../src/infrastructure/environment.js";

test("loads the OpenRouter key from an env file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stunthog-env-"));
  const previous = process.env.OPENROUTER_API_KEY;

  delete process.env.OPENROUTER_API_KEY;

  try {
    const path = join(directory, ".env");

    await writeFile(path, "OPENROUTER_API_KEY=test-key\n");
    loadEnvironment(path);

    assert.equal(process.env.OPENROUTER_API_KEY, "test-key");
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;

    await rm(directory, { recursive: true, force: true });
  }
});
