import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "stunthog-test-"));

  const workspace = join(root, "project");

  const skill = join(root, "skill");

  await mkdir(workspace);

  await mkdir(skill);

  await writeFile(join(workspace, "app.ts"), "original");

  await writeFile(join(workspace, ".env"), "secret");

  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: test-skill\ndescription: Test the project.\n---\nRead app.ts.\n",
  );

  return { root, workspace, skill };
}
