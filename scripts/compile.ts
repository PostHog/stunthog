import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const releaseDirectory = resolve("release");
const executable = resolve(
  releaseDirectory,
  process.platform === "win32" ? "stunthog.exe" : "stunthog",
);

await rm(releaseDirectory, { recursive: true, force: true });
await mkdir(releaseDirectory, { recursive: true });

const result = await Bun.build({
  entrypoints: [resolve("dist/cli.js")],
  compile: {
    outfile: executable,
    assets: ["web/dist", "prisma/migrations", "node_modules/.prisma/client"],
  },
  minify: true,
  sourcemap: "none",
  external: [
    "@nestjs/microservices",
    "@nestjs/microservices/*",
    "@nestjs/websockets/*",
    "class-transformer",
    "class-validator",
  ],
});

if (!result.success)
  throw new AggregateError(result.logs, "Could not compile StuntHog.");

console.log(executable);
