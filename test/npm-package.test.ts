import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { packageNpm } from "../scripts/package-npm.js";

const require = createRequire(import.meta.url);
const { binaries, binaryName, isNewerVersion } =
  require("../npm/stunthog.cjs") as {
    binaries: Record<string, string>;
    binaryName: (platform: string, architecture: string) => string;
    isNewerVersion: (latest: string, installed: string) => boolean;
  };

test("update checks only offer newer stable npm versions", () => {
  assert.equal(isNewerVersion("0.1.10", "0.1.9"), true);
  assert.equal(isNewerVersion("0.1.4", "0.1.4-rc.1"), true);
  assert.equal(isNewerVersion("0.1.4", "0.1.4+test"), false);
  assert.equal(isNewerVersion("0.1.4", "0.1.5-rc.1"), false);
  assert.equal(isNewerVersion("0.1.5-rc.1", "0.1.4"), false);
  assert.equal(isNewerVersion("0.1.5 && other-command", "0.1.4"), false);
});

test("npm package includes release checksums, no binaries or dependencies, and rejects incomplete releases", async () => {
  const root = await mkdtemp(join(tmpdir(), "stunthog-npm-"));
  const output = join(root, "package");
  try {
    await assert.rejects(packageNpm(root, output), /ENOENT/);
    const archives = Object.values(binaries).map((name) =>
      name.endsWith(".exe") ? name.replace(/\.exe$/, ".zip") : `${name}.tar.gz`,
    );
    for (const archive of archives)
      await writeFile(
        join(root, `${archive}.sha256`),
        `${"a".repeat(64)}  ${archive}\n`,
      );
    await assert.rejects(
      packageNpm(root, output, "v0.0.0-wrong"),
      /does not match/,
    );
    await packageNpm(root, output);
    const manifest = JSON.parse(
      await readFile(join(output, "package.json"), "utf8"),
    );
    assert.equal(manifest.name, "stunthog");
    assert.equal(manifest.bin.stunthog, "bin/stunthog.cjs");
    const readme = await readFile(join(output, "README.md"), "utf8");
    const images = `https://raw.githubusercontent.com/PostHog/stunthog/v${manifest.version}/images`;
    assert.ok(readme.includes(`src="${images}/stunthog-header.png"`));
    assert.equal(manifest.private, undefined);
    assert.equal(manifest.dependencies, undefined);
    assert.equal(manifest.optionalDependencies, undefined);
    assert.equal(manifest.scripts.postinstall, "node bin/install.cjs");
    assert.deepEqual(
      (await readdir(output)).sort(),
      ["README.md", "bin", "package.json"].sort(),
    );
    const checksums = JSON.parse(
      await readFile(join(output, "bin/checksums.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(checksums).sort(), archives.sort());
    assert.equal(archives.length, 5);
    assert.throws(() => binaryName("win32", "arm64"), /does not support/);
    await writeFile(join(root, "stunthog-linux-x64.tar.gz.sha256"), "invalid");
    await assert.rejects(packageNpm(root, output), /Invalid checksum/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("npm launcher forwards arguments, terminal IO, signals, exit codes, and spawn errors", async () => {
  const source = await readFile(
    new URL("../npm/stunthog.cjs", import.meta.url),
    "utf8",
  );
  const child = new EventEmitter();
  const forwarded: string[] = [];
  Object.assign(child, { kill: (signal: string) => forwarded.push(signal) });
  const signals: string[] = [];
  const installs: string[][] = [];
  const notice: string[] = [];
  const prefix = resolve("test prefix");
  const packageRoot = join(prefix, "lib", "node_modules", "stunthog");
  let latest: string | undefined;
  const args = ["--data", "folder with spaces", "--port", "3210"];
  const fakeProcess = Object.assign(new EventEmitter(), {
    platform: "linux",
    arch: "x64",
    pid: 123,
    argv: ["node", "launcher.cjs", ...args],
    env: {},
    exitCode: undefined as number | undefined,
    kill: (_pid: number, signal: string) => signals.push(signal),
  });
  const module = { exports: {} };
  const mockRequire = Object.assign(
    (id: string) => {
      if (id === "../package.json") return { version: "0.1.4" };
      if (id !== "node:child_process") return require(id);
      return {
        spawn: (file: string, args: string[], options: { stdio: string }) => {
          assert.equal(
            file,
            join(packageRoot, "binaries", "stunthog-linux-x64"),
          );
          assert.deepEqual(Array.from(args), [
            "--data",
            "folder with spaces",
            "--port",
            "3210",
          ]);
          assert.equal(options.stdio, "inherit");
          return child;
        },
        spawnSync: (
          file: string,
          args: string[],
          options: { env: Record<string, string>; shell: boolean },
        ) => {
          assert.equal(file, "npm");
          assert.equal(options.env.npm_config_prefix, prefix);
          assert.equal(options.shell, false);
          installs.push(Array.from(args));
          return { status: 0 };
        },
      };
    },
    { main: module },
  );
  const launch = () =>
    runInNewContext(source, {
      require: mockRequire,
      module,
      __dirname: join(packageRoot, "bin"),
      process: fakeProcess,
      AbortSignal,
      fetch: async (url: string) => {
        assert.equal(url, "https://registry.npmjs.org/stunthog/latest");
        if (!latest) throw new Error("offline");
        return Response.json({ version: latest });
      },
      console: { error: (message: string) => notice.push(message) },
    });

  await launch();
  fakeProcess.emit("SIGTERM");
  assert.deepEqual(forwarded, ["SIGTERM"]);
  child.emit("close", 17, null);
  assert.equal(fakeProcess.exitCode, 17);
  assert.equal(fakeProcess.listenerCount("SIGTERM"), 0);
  child.removeAllListeners();
  latest = "0.1.5";
  await launch();
  assert.match(notice[0] ?? "", /0\.1\.5 is available/);
  assert.equal(installs.length, 0);
  child.emit("close", null, "SIGINT");
  assert.deepEqual(signals, ["SIGINT"]);
  child.removeAllListeners();
  fakeProcess.argv.splice(2, 0, "--auto-update");
  await launch();
  assert.equal(installs[0]?.at(-1), "stunthog@0.1.5");
  child.emit("error", new Error("ENOENT"));
  child.emit("close", -2, null);
  assert.match(notice.at(-1) ?? "", /Could not start StuntHog: ENOENT/);
  assert.notEqual(fakeProcess.exitCode, 0);
});
