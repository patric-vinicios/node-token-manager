import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  readonly db: Database;
  readonly pool: Pool;
  /** Verify connectivity with a trivial round-trip query. */
  ping(): Promise<void>;
  /** Close the underlying connection pool. */
  close(): Promise<void>;
}

/**
 * Create a pooled Postgres client wrapped in Drizzle. Does not connect eagerly;
 * call {@link DbHandle.ping} during startup to fail fast on an unreachable DB.
 */
export function createDb(databaseUrl: string): DbHandle {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    async ping() {
      await db.execute(sql`SELECT 1`);
    },
    async close() {
      await pool.end();
    },
  };
}
