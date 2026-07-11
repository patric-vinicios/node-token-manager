import { existsSync } from "node:fs";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { StartupError } from "../lib/errors";
import type { Database } from "./client";

/** Absolute path to the drizzle-kit migrations folder (repo root `drizzle/`). */
export const MIGRATIONS_FOLDER = path.resolve(__dirname, "../../drizzle");

/**
 * Apply generated migrations at startup. Throws a store-identifying
 * {@link StartupError} on failure so the service aborts before accepting
 * traffic (PRD F01: no traffic in a degraded state).
 */
export async function runMigrations(
  db: Database,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<void> {
  if (!existsSync(migrationsFolder)) {
    throw new StartupError(
      `PostgreSQL history store: migrations folder not found at ${migrationsFolder} (run "npm run db:generate")`,
    );
  }
  try {
    await migrate(db, { migrationsFolder });
  } catch (err) {
    throw new StartupError(
      "PostgreSQL history store: failed to apply migrations",
      err,
    );
  }
}

// Allow `npm run db:migrate` to apply migrations against DATABASE_URL directly.
if (require.main === module) {
  void (async () => {
    const { createDb } = await import("./client");
    const url = process.env.DATABASE_URL;
    if (!url) {
      process.stderr.write("DATABASE_URL is required to run migrations\n");
      process.exit(1);
    }
    const handle = createDb(url);
    try {
      await runMigrations(handle.db);
      process.stdout.write("Migrations applied\n");
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exitCode = 1;
    } finally {
      await handle.close();
    }
  })();
}
