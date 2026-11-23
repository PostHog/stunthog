#!/usr/bin/env node
const { spawn, spawnSync } = require("node:child_process");
const { join, resolve } = require("node:path");

const registry = "https://registry.npmjs.org";
const packageName = "@posthog/stunthog";

const binaries = {
  "darwin-arm64": "stunthog-darwin-arm64",
  "darwin-x64": "stunthog-darwin-x64",
  "linux-arm64": "stunthog-linux-arm64",
  "linux-x64": "stunthog-linux-x64",
  "win32-x64": "stunthog-windows-x64.exe",
};

function binaryName(platform, architecture) {
  const name = binaries[`${platform}-${architecture}`];
  if (!name) {
    throw new Error(`StuntHog does not support ${platform}/${architecture}.`);
  }
  return name;
}

function isNewerVersion(latest, installed) {
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  const candidate = typeof latest === "string" && stable.exec(latest);
  const current = stable.exec(installed.split(/[-+]/, 1)[0]);
  if (!candidate || !current) return false;

  for (let part = 1; part <= 3; part++) {
    const next = BigInt(candidate[part]);
    const previous = BigInt(current[part]);
    if (next !== previous) return next > previous;
  }
  return installed.split("+", 1)[0].includes("-");
}

async function checkForUpdate(autoUpdate) {
  let latest;
  try {
    const response = await fetch(`${registry}/@posthog%2fstunthog/latest`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return;
    latest = (await response.json()).version;
  } catch {
    return;
  }

  const { version } = require("../package.json");
  if (!isNewerVersion(latest, version)) return;

  const command = `npm install -g ${packageName}@${latest}`;
  if (!autoUpdate) {
    console.error(
      `StuntHog ${latest} is available (installed ${version}). Update with ${command} or run stunthog --auto-update.`,
    );
    return;
  }

  const windows = process.platform === "win32";
  const prefix = resolve(__dirname, windows ? "../../../.." : "../../../../..");
  const modules = windows
    ? join(prefix, "node_modules")
    : join(prefix, "lib", "node_modules");
  if (__dirname !== join(modules, packageName, "bin")) {
    console.error(
      `Automatic updates require a global npm installation. Update with ${command}.`,
    );
    return;
  }

  console.error(`Updating StuntHog from ${version} to ${latest}…`);
  // Keep the prefix out of the Windows command shell and update before the executable is in use.
  const result = spawnSync(
    "npm",
    [
      "install",
      "--global",
      "--ignore-scripts=false",
      "--no-audit",
      "--no-fund",
      `--registry=${registry}`,
      `${packageName}@${latest}`,
    ],
    {
      shell: windows,
      stdio: "inherit",
      env: {
        ...process.env,
        npm_config_prefix: prefix,
        NPM_CONFIG_PREFIX: prefix,
      },
    },
  );
  if (result.status !== 0) {
    console.error(`Could not update StuntHog. Try ${command}.`);
  }
}

async function main() {
  const executable = join(
    __dirname,
    "..",
    "binaries",
    binaryName(process.platform, process.arch),
  );
  const args = process.argv.slice(2);
  const autoUpdate = args[0] === "--auto-update";
  if (autoUpdate) args.shift();
  if (!args.some((arg) => ["--help", "-h", "--version", "-V"].includes(arg))) {
    await checkForUpdate(
      autoUpdate ||
        (process.env.STUNTHOG_AUTO_UPDATE ??
          process.env.AGENT_EVAL_AUTO_UPDATE) === "1",
    );
  }
  const child = spawn(executable, args, { stdio: "inherit" });

  // Forward signals sent to the npm launcher so the server can shut down cleanly.
  const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
    const handler = () => child.kill(signal);
    process.on(signal, handler);
    return [signal, handler];
  });
  child.once("error", (error) => {
    console.error(`Could not start StuntHog: ${error.message}`);
    if (error.code === "ENOENT") {
      console.error(
        `Reinstall with npm install -g ${packageName} --ignore-scripts=false to download the executable.`,
      );
    }
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    for (const [name, handler] of handlers)
      process.removeListener(name, handler);
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code !== null && code >= 0 ? code : 1;
  });
}

module.exports = { binaries, binaryName, isNewerVersion };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
