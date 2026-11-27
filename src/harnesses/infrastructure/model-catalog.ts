import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Provider } from "../../credentials/provider.js";
import { resolveDataDirectory } from "../../infrastructure/data-directory.js";

let runtime: Promise<ModelRuntime> | undefined;

// The bundled SDK catalog supplies model IDs without spending credits or reading user logins.
export function catalogRuntime() {
  runtime ??= ModelRuntime.create({
    authPath: join(resolveDataDirectory(), "catalog-auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  return runtime;
}

export async function providerModels(provider: Provider) {
  return (await catalogRuntime())
    .getModels(provider)
    .map((model) => ({ id: model.id, name: model.name }));
}
