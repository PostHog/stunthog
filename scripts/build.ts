import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { buildRelay } from "../src/overrides/infrastructure/relay-source.js";

async function run(args: string[]) {
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });

  if (code !== 0) throw new Error(`Build step failed with exit code ${code}.`);
}

// Clear only generated server files so removed legacy modules cannot remain in a build.
await run(["x", "prisma", "generate"]);

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
await run(["x", "tsc", "-p", "tsconfig.build.json"]);
await writeFile(
  new URL("../dist/overrides/infrastructure/relay-source.js", import.meta.url),
  `export const relaySource = () => ${JSON.stringify(await buildRelay())};\n`,
);
await run(["x", "vite", "build", "--config", "web/vite.config.ts"]);
