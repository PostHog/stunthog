import { copyFile, mkdir, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

const excluded = new Set([
  ".git",
  "node_modules",
  ".pi",
  ".agents",
  ".codex",
  ".env",
  ".next",
  ".stunthog",
  ".agent-eval",
]);
export function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);

  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

export async function snapshot(
  source: string,
  target: string,
  omit: string[] = [],
): Promise<void> {
  await mkdir(target, { recursive: true });

  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);

    if (
      excluded.has(entry.name) ||
      entry.name.startsWith(".env.") ||
      omit.some((path) => contains(path, from))
    )
      continue;

    const to = join(target, entry.name);

    if (entry.isSymbolicLink())
      throw new Error(`Remove the symbolic link from the input: ${from}`);

    if (entry.isDirectory()) await snapshot(from, to, omit);
    else if (entry.isFile()) await copyFile(from, to);
    else throw new Error(`Unsupported input file: ${from}`);
  }
}
