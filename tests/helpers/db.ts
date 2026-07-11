import { sql } from "drizzle-orm";
import { createDb, type DbHandle } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";

/**
 * Connection string for the disposable test database. Defaults to the
 * docker-compose Postgres so `docker compose up -d && npm test` works out of
 * the box; override with DATABASE_URL to point at another instance.
 */
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/token_management";

/** Connect, verify connectivity, and apply migrations. */
export async function setupTestDb(): Promise<DbHandle> {
  const handle = createDb(TEST_DATABASE_URL);
  await handle.ping();
  await runMigrations(handle.db);
  return handle;
}

/** Wipe both tables so each test starts from a clean, empty pool. */
export async function truncateAll(handle: DbHandle): Promise<void> {
  await handle.db.execute(
    sql`TRUNCATE TABLE usage_history, tokens RESTART IDENTITY CASCADE`,
  );
}

/** Count rows in a table by unquoted identifier (test-only helper). */
export async function countRows(
  handle: DbHandle,
  table: "tokens" | "usage_history",
): Promise<number> {
  const ident = table === "tokens" ? sql`tokens` : sql`usage_history`;
  const rows = await handle.db.execute<{ count: number }>(
    sql`SELECT count(*)::int AS count FROM ${ident}`,
  );
  return Number(rows.rows[0]?.count ?? 0);
}
