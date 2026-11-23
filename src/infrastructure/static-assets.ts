import { extname, resolve, sep } from "node:path";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { runtimePath } from "./runtime-path.js";

export function serveWebAssets(app: NestExpressApplication): void {
  const root = runtimePath("web/dist");

  if (Bun.embeddedFiles.length === 0) {
    const registerStaticAssets = app.useStaticAssets.bind(app);

    registerStaticAssets(root);
    return;
  }

  app.use(
    async (
      request: { path: string },
      response: {
        send: (body: Uint8Array) => void;
        type: (path: string) => void;
      },
      next: (error?: unknown) => void,
    ) => {
      if (request.path.startsWith("/api/")) {
        next();
        return;
      }

      try {
        const requested = resolve(root, `.${request.path}`);
        const safe =
          requested === root || requested.startsWith(`${root}${sep}`);
        const file =
          safe && (await Bun.file(requested).exists())
            ? requested
            : resolve(root, "index.html");

        response.type(extname(file));
        response.send(new Uint8Array(await Bun.file(file).arrayBuffer()));
      } catch (error) {
        next(error);
      }
    },
  );
}
