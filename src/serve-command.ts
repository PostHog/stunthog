import { Injectable } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Command, CommandRunner, Option } from "nest-commander";
import open from "open";
import { z } from "zod";
import { ApplicationModule } from "./application.module.js";
import { ApiErrorFilter } from "./http/api-error-filter.js";
import { resolveDataDirectory } from "./infrastructure/data-directory.js";
import { Database } from "./infrastructure/database.js";
import { migrateDatabase } from "./infrastructure/migrations.js";
import { serveWebAssets } from "./infrastructure/static-assets.js";

interface ServeOptions {
  port?: number;
  data?: string;
  open?: boolean;
}

@Injectable()
@Command({
  name: "serve",
  description: "Start the local evaluation app",
  options: { isDefault: true },
})
export class ServeCommand extends CommandRunner {
  // The CLI owns the process. Nest owns HTTP, persistence, and worker shutdown.
  async run(_arguments: string[], options: ServeOptions): Promise<void> {
    await migrateDatabase(options.data);

    const app = await NestFactory.create<NestExpressApplication>(
      ApplicationModule,
      { logger: ["error", "warn"] },
    );

    app.enableShutdownHooks();
    app.useGlobalFilters(new ApiErrorFilter());
    app.use(
      (
        request: { headers: Record<string, string | undefined> },
        response: {
          status: (code: number) => { end: () => void };
          setHeader: (name: string, value: string) => void;
        },
        next: () => void,
      ) => {
        const host = request.headers.host ?? "";
        const origin = request.headers.origin;

        if (
          !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) ||
          (origin && origin !== `http://${host}`)
        ) {
          response.status(403).end();
          return;
        }

        response.setHeader("X-Content-Type-Options", "nosniff");
        next();
      },
    );
    app.useBodyParser("json", { limit: "3mb" });
    serveWebAssets(app);

    // Native harness processes cannot resume after an application restart.
    await app.get(Database).session.updateMany({
      where: { status: { in: ["queued", "running", "judging"] } },
      data: {
        status: "failed",
        error: "The application stopped before this session finished.",
        finishedAt: new Date(),
      },
    });
    await app.listen(options.port ?? 3100, "127.0.0.1");

    const url = await app.getUrl();

    console.log(
      `StuntHog: ${url}\nData directory: ${resolveDataDirectory()}\nPress Ctrl+C to stop.`,
    );
    process.send?.("stunthog:listening");

    if (options.open !== false)
      await open(url).catch(() =>
        console.log("Open the application URL in your browser."),
      );
  }

  @Option({ flags: "-p, --port <port>", description: "Local HTTP port" })
  port(value: string): number {
    return z.coerce.number().int().min(1).max(65535).parse(value);
  }

  @Option({
    flags: "--data <directory>",
    description:
      "Directory for SQLite and the encryption key. New installations use ~/.stunthog.",
  })
  data(value: string): string {
    return value;
  }

  @Option({ flags: "--no-open", description: "Do not open a browser" })
  browser(): boolean {
    return false;
  }
}
