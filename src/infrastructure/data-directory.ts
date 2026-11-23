import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolveDatabasePath(directory: string): string {
  const suffix = Bun.isStandaloneExecutable ? ".db" : "_dev.db";
  const current = join(directory, `stunthog${suffix}`);
  const previous = join(directory, `agent-eval${suffix}`);
  return !existsSync(current) && existsSync(previous) ? previous : current;
}

export function resolveDataDirectory(
  directory = process.env.STUNTHOG_DATA_DIR || process.env.AGENT_EVAL_DATA_DIR,
): string {
  if (directory) return resolve(directory);
  const current = join(homedir(), ".stunthog");
  if (existsSync(resolveDatabasePath(current))) return current;
  const previous = join(homedir(), ".agent-eval");
  return existsSync(resolveDatabasePath(previous)) ? previous : current;
}
