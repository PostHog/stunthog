import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FilesystemController } from "../src/http/filesystem-controller.js";

test("the local path picker lists folders and requested files", async () => {
  const root = await mkdtemp(join(tmpdir(), "stunthog-picker-"));

  try {
    await mkdir(join(root, "project"));
    await writeFile(join(root, "Dockerfile"), "FROM scratch\n");

    const controller = new FilesystemController();
    const folders = await controller.browse("directory", root);
    const files = await controller.browse("file", root);

    assert.deepEqual(
      folders.entries.map((entry) => entry.name),
      ["project"],
    );
    assert.deepEqual(
      files.entries.map((entry) => entry.name),
      ["project", "Dockerfile"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
