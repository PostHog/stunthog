import { Database as SQLite } from "bun:sqlite";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { backfillToolCalls } from "../sessions/infrastructure/tool-call-index.js";
import { resolveDatabasePath, resolveDataDirectory } from "./data-directory.js";
import { runtimePath } from "./runtime-path.js";

// Apply committed migrations before repositories or workers start.
export async function migrateDatabase(dataDirectory?: string): Promise<void> {
  const directory = resolveDataDirectory(dataDirectory);

  await mkdir(directory, { recursive: true });

  process.env.STUNTHOG_DATA_DIR = directory;
  const databasePath = resolveDatabasePath(directory);

  process.env.DATABASE_URL = `file:${databasePath}`;

  const database = new SQLite(databasePath, { create: true });

  try {
    database.exec("PRAGMA foreign_keys = OFF");
    const tables = new Set(
      database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        )
        .all()
        .map(({ name }) => name),
    );
    const history = tables.has("_agent_eval_migrations")
      ? "_agent_eval_migrations"
      : "_stunthog_migrations";
    database.exec(`
      CREATE TABLE IF NOT EXISTS "${history}" (
        "name" TEXT NOT NULL PRIMARY KEY,
        "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    if (tables.has("_prisma_migrations"))
      database.exec(`
        INSERT OR IGNORE INTO "${history}" ("name")
        SELECT "migration_name" FROM "_prisma_migrations"
        WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
      `);

    const migrations = runtimePath("prisma/migrations");
    const applied = database
      .query<{ name: string }, []>(`SELECT "name" FROM "${history}"`)
      .all();
    const completed = new Set(applied.map(({ name }) => name));
    const entries = (await readdir(migrations, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (completed.has(entry.name)) continue;

      const sql = await readFile(
        join(migrations, entry.name, "migration.sql"),
        "utf8",
      );
      const apply = database.transaction(() => {
        database.exec(sql);
        if (entry.name === "202611180004_tool_call_lookup")
          backfillToolCalls(database);
        database
          .query(`INSERT INTO "${history}" ("name") VALUES (?)`)
          .run(entry.name);
      });

      apply();
    }
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
    database.close();
  }
}
