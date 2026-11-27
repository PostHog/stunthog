const generate = Bun.spawn([process.execPath, "run", "db:generate"], {
  stdout: "inherit",
  stderr: "inherit",
});
if ((await generate.exited) !== 0) process.exit(generate.exitCode ?? 1);

const ready = Promise.withResolvers<boolean>();
const server = Bun.spawn(
  [process.execPath, "--watch", "src/cli.ts", "serve", "--no-open"],
  {
    stdout: "inherit",
    stderr: "inherit",
    ipc(message) {
      if (message === "stunthog:listening") ready.resolve(true);
    },
  },
);
const children = [server];
let stopping = false;
const stop = () => {
  stopping = true;
  for (const child of children) child.kill();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  if (
    (await Promise.race([ready.promise, server.exited.then(() => false)])) &&
    !stopping
  ) {
    children.push(
      Bun.spawn(
        [
          process.execPath,
          "node_modules/vite/bin/vite.js",
          "--config",
          "web/vite.config.ts",
          "--open",
        ],
        { stdout: "inherit", stderr: "inherit" },
      ),
    );
  }
  process.exitCode = await Promise.race(children.map((child) => child.exited));
} finally {
  stop();
  await Promise.all(children.map((child) => child.exited));
}
