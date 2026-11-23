const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createWriteStream } = require("node:fs");
const { chmod, mkdir, mkdtemp, rename, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { binaryName } = require("./stunthog.cjs");

async function install() {
  const name = binaryName(process.platform, process.arch);
  const archive = name.endsWith(".exe")
    ? name.replace(/\.exe$/, ".zip")
    : `${name}.tar.gz`;
  const checksum = require("./checksums.json")[archive];
  const { version } = require("../package.json");
  const destination = join(__dirname, "..", "binaries");
  await mkdir(destination, { recursive: true });
  const temporary = await mkdtemp(join(destination, ".download-"));

  try {
    const url = `https://github.com/PostHog/stunthog/releases/download/v${encodeURIComponent(version)}/${archive}`;
    console.log(
      `Downloading StuntHog ${version} for ${process.platform}/${process.arch}…`,
    );
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body)
      throw new Error(`Download failed (HTTP ${response.status})`);

    const hash = createHash("sha256");
    const archivePath = join(temporary, archive);
    await pipeline(
      response.body,
      new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(archivePath),
    );
    if (hash.digest("hex") !== checksum)
      throw new Error(`Checksum mismatch for ${archive}`);

    // Git for Windows can put GNU tar ahead of the system tar that supports ZIP.
    const tar =
      process.platform === "win32"
        ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
        : "tar";
    execFileSync(tar, ["-xf", archive, name], {
      cwd: temporary,
      stdio: "inherit",
    });
    const executable = join(temporary, name);
    await chmod(executable, 0o755);
    await rename(executable, join(destination, name));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

install().catch((error) => {
  console.error(`Could not install StuntHog: ${error.message}`);
  process.exitCode = 1;
});
