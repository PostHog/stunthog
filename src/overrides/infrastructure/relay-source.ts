// The production build embeds this helper as text so Docker needs only Node.js.
export async function buildRelay(): Promise<string> {
  const build = await Bun.build({
    entrypoints: [`${import.meta.dir}/relay-entry.ts`],
    target: "node",
    format: "cjs",
    minify: true,
  });
  if (!build.success || !build.outputs[0])
    throw new AggregateError(build.logs, "Cannot build the response tool.");
  return build.outputs[0].text();
}

let source: Promise<string> | undefined;
export function relaySource() {
  source ??= buildRelay();
  return source;
}
