import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Durable pool identity set. The 100 token UUIDs are seeded once and reloaded
 * on every boot so history (F05) and detail (F06) stay queryable by a stable
 * token UUID across restarts (spec Data Model / Decisions).
 *
 * `id` has no DB default: token UUIDs are app-generated (crypto.randomUUID) so
 * the seeder controls duplicate handling.
 */
export const tokens = pgTable("tokens", {
  id: uuid("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Durable per-token audit trail. Schema is created by F01; rows are written by
 * F02, closed by F03/F07 (and startup reconciliation), and queried by F05/F06.
 * A row with `released_at IS NULL` represents an open/active hold.
 */
export const usageHistory = pgTable(
  "usage_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id),
    userId: uuid("user_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    // varchar enum pattern (not native ENUM) so consumers add reasons without a
    // migration: ttl | eviction | clear | startup_reconciliation.
    releaseReason: varchar("release_reason", { length: 32 }),
  },
  (table) => [
    index("ix_usage_history_token_id").on(table.tokenId),
    index("ix_usage_history_token_started").on(table.tokenId, table.startedAt),
    index("ix_usage_history_open")
      .on(table.tokenId)
      .where(sql`${table.releasedAt} IS NULL`),
    check(
      "chk_release_after_start",
      sql`${table.releasedAt} IS NULL OR ${table.releasedAt} >= ${table.startedAt}`,
    ),
  ],
);

export type TokenRow = typeof tokens.$inferSelect;
export type UsageHistoryRow = typeof usageHistory.$inferSelect;

/** Release reasons used across features when closing a history entry. */
export const ReleaseReason = {
  TTL: "ttl",
  EVICTION: "eviction",
  CLEAR: "clear",
  STARTUP_RECONCILIATION: "startup_reconciliation",
} as const;

export type ReleaseReason = (typeof ReleaseReason)[keyof typeof ReleaseReason];
