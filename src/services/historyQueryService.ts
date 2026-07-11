import { asc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { usageHistory } from "../db/schema";
import { NotFoundError } from "../lib/errors";
import type { TokenRegistry } from "../registry/tokenRegistry";

/**
 * Read-only query side of the usage-history audit trail (PRD F05).
 *
 * F02 owns the write path (`historyWriter`): every assignment opens a row and
 * evictions close-then-open in a transaction. F05 adds only this query — it
 * never inserts, updates, or deletes rows.
 *
 * Existence is checked against the in-memory {@link TokenRegistry}, which holds
 * the fixed set of 100 seeded token UUIDs for the process lifetime. This lets an
 * unknown token UUID (404) be distinguished from a known token with no history
 * (200, empty array) without an extra `tokens`-table round trip, keeping the
 * read fast (PRD Objective: sub-200ms reads at a full pool).
 */

/** One entry in a token's chronological usage history. */
export interface HistoryEntry {
  readonly userId: string;
  /** When this hold began. */
  readonly startedAt: Date;
  /** When this hold ended; `null` while the hold is still open (active). */
  readonly releasedAt: Date | null;
}

export interface HistoryQueryService {
  /**
   * Return the full chronological history (oldest first) for a seeded token.
   * Throws {@link NotFoundError} if the id is not one of the 100 pool tokens.
   */
  getHistory(tokenId: string): Promise<HistoryEntry[]>;
}

export interface HistoryQueryServiceDeps {
  readonly registry: TokenRegistry;
  readonly db: Database;
}

export function createHistoryQueryService(
  deps: HistoryQueryServiceDeps,
): HistoryQueryService {
  const { registry, db } = deps;

  return {
    async getHistory(tokenId: string): Promise<HistoryEntry[]> {
      // Reject an unknown token before touching the DB (404 vs. empty-array 200).
      if (!registry.has(tokenId)) {
        throw new NotFoundError(`Token not found: ${tokenId}`);
      }

      // Ordered per-token read; served by ix_usage_history_token_started.
      return db
        .select({
          userId: usageHistory.userId,
          startedAt: usageHistory.startedAt,
          releasedAt: usageHistory.releasedAt,
        })
        .from(usageHistory)
        .where(eq(usageHistory.tokenId, tokenId))
        .orderBy(asc(usageHistory.startedAt));
    },
  };
}
