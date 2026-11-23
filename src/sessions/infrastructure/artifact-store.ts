import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import { resolveDataDirectory } from "../../infrastructure/data-directory.js";
import { Database } from "../../infrastructure/database.js";
import type { ExecutionSnapshot } from "../domain/execution-snapshot.js";
import { WorkspaceStore } from "../domain/workspace-store.js";
import { contains } from "./workspace-files.js";
import { prepareWorkspaceSource } from "./workspace-source.js";

const ignored = new Set([
  "node_modules",
  ".git",
  ".next",
  ".env",
  "credential.key",
  "auth.json",
]);

@Injectable()
export class ArtifactStore extends WorkspaceStore {
  constructor(@Inject(Database) private readonly db: Database) {
    super();
  }

  // Capture one source tree for the whole batch, then persist identical inputs for every session.
  async prepare(
    sessionIds: string[],
    snapshot: ExecutionSnapshot,
  ): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "stunthog-input-"));

    try {
      await prepareWorkspaceSource(
        snapshot.environment,
        join(root, "workspace"),
        [resolveDataDirectory()],
      );

      for (const [index, skill] of snapshot.skills.entries()) {
        const directory = join(root, "skills", String(index));

        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, "SKILL.md"),
          skillDocument(skill.title, skill.content),
        );
      }
      for (const id of sessionIds) await this.capture(id, root, "input");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  async capture(
    sessionId: string,
    root: string,
    phase: string,
    prefix = "",
  ): Promise<void> {
    const entries = await readdir(root, { withFileTypes: true });

    for (const entry of entries) {
      if (ignored.has(entry.name) || entry.name.startsWith(".env.")) continue;

      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isSymbolicLink())
        throw new Error(`Cannot save a symbolic link: ${path}`);
      if (entry.isDirectory())
        await this.capture(sessionId, join(root, entry.name), phase, path);
      else if (entry.isFile()) {
        const content = await readFile(join(root, entry.name));

        await this.db.sessionArtifact.upsert({
          where: { sessionId_phase_path: { sessionId, phase, path } },
          create: { sessionId, phase, path, content },
          update: { content },
        });
      }
    }
  }

  async restore(sessionId: string, root: string, phase: string): Promise<void> {
    const files = await this.db.sessionArtifact.findMany({
      where: { sessionId, phase },
    });

    await mkdir(root, { recursive: true });

    for (const file of files) {
      const target = resolve(root, file.path);

      if (!contains(resolve(root), target))
        throw new Error("Invalid artifact path.");

      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }
  }
}

export function skillDocument(title: string, content: string): string {
  const body = content.trim();
  if (/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(body)) return `${body}\n`;

  const name =
    title
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "") || "skill";

  return `---\nname: ${name}\ndescription: ${JSON.stringify(title)}\n---\n${body}\n`;
}
