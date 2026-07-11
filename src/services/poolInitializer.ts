import { randomUUID } from "node:crypto";
import { isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { tokens, usageHistory, ReleaseReason } from "../db/schema";
import { StartupError } from "../lib/errors";
import type { TokenRegistry } from "../registry/tokenRegistry";
import type { Logger } from "../lib/logger";

const MAX_SEED_RETRIES = 5;

export interface PoolInitResult {
  /** The stable pool identity set (seeded or loaded), size === poolSize. */
  readonly tokenIds: string[];
  /** True when tokens were freshly seeded on this boot. */
  readonly seeded: boolean;
  /** Number of orphaned open history rows closed during reconciliation. */
  readonly reconciledOpenEntries: number;
}

export interface PoolInitializerDeps {
  readonly db: Database;
  readonly poolSize: number;
  readonly logger: Logger;
  /**
   * Injectable UUID generator. Defaults to crypto v4. Tests may pass a
   * collision-prone generator to exercise the regenerate-on-duplicate path.
   */
  readonly generateId?: () => string;
}

/**
 * Seed-or-load the fixed pool identity set and reconcile orphaned history.
 *
 * - Empty pool → seed exactly `poolSize` unique UUIDs (transactional).
 * - Existing pool of exactly `poolSize` → reload the same IDs, no reseed.
 * - Any other count → fatal abort (no resize, no partial seed).
 *
 * Then closes any `usage_history` row left open by a prior crash/restart, since
 * active state is process-local and does not survive a restart.
 */
export async function initializePool(
  deps: PoolInitializerDeps,
): Promise<PoolInitResult> {
  const { db, poolSize, logger, generateId = randomUUID } = deps;

  const tokenIds = await seedOrLoad(db, poolSize, logger, generateId);
  const seeded = tokenIds.seeded;

  const reconciledOpenEntries = await reconcileOpenHistory(db);
  if (reconciledOpenEntries > 0) {
    logger.warn("Closed orphaned open history entries at startup", {
      count: reconciledOpenEntries,
      reason: ReleaseReason.STARTUP_RECONCILIATION,
    });
  }

  return { tokenIds: tokenIds.ids, seeded, reconciledOpenEntries };
}

async function seedOrLoad(
  db: Database,
  poolSize: number,
  logger: Logger,
  generateId: () => string,
): Promise<{ ids: string[]; seeded: boolean }> {
  const existing = await db
    .select({ id: tokens.id })
    .from(tokens)
    .orderBy(tokens.createdAt, tokens.id);

  if (existing.length === poolSize) {
    return { ids: existing.map((r) => r.id), seeded: false };
  }

  if (existing.length === 0) {
    const ids = await seedTokens(db, poolSize, logger, generateId);
    return { ids, seeded: true };
  }

  // Any non-empty count that isn't exactly poolSize is an inconsistent pool:
  // never resize or partially reseed (spec: pool size immutable).
  throw new StartupError(
    `Inconsistent token pool: found ${existing.length} tokens but POOL_SIZE=${poolSize}. ` +
      `Refusing to seed or resize; the pool is immutable.`,
  );
}

/**
 * Seed `poolSize` unique tokens inside a transaction. On a duplicate UUID
 * collision (astronomically unlikely for v4) the whole attempt is retried with
 * a freshly generated set; after MAX_SEED_RETRIES it aborts fatally.
 */
async function seedTokens(
  db: Database,
  poolSize: number,
  logger: Logger,
  generateId: () => string,
): Promise<string[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_SEED_RETRIES; attempt++) {
    const ids = generateUniqueIds(poolSize, generateId);
    try {
      await db.transaction(async (tx) => {
        // Guard against a concurrent seeder: fail if the table isn't empty.
        const countRows = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(tokens);
        const count = countRows[0]?.count ?? 0;
        if (count !== 0) {
          throw new StartupError(
            `Token pool changed during seeding (found ${count} rows); aborting to avoid a partial pool.`,
          );
        }
        await tx.insert(tokens).values(ids.map((id) => ({ id })));
      });
      logger.info("Token pool seeded", { count: poolSize, attempt });
      return ids;
    } catch (err) {
      lastErr = err;
      if (err instanceof StartupError) throw err;
      if (isUniqueViolation(err) && attempt < MAX_SEED_RETRIES) {
        logger.warn("Duplicate UUID during seeding; regenerating", { attempt });
        continue;
      }
      throw new StartupError("Failed to seed token pool", err);
    }
  }
  throw new StartupError("Failed to seed a unique token set", lastErr);
}

/**
 * Generate `count` guaranteed-distinct UUIDs. Duplicates from `genId` are
 * discarded (regenerate-on-duplicate per PRD), and draws are bounded so a
 * degenerate generator aborts fatally instead of looping forever.
 */
export function generateUniqueIds(
  count: number,
  genId: () => string = randomUUID,
): string[] {
  const set = new Set<string>();
  const maxDraws = count * 50 + 100;
  let draws = 0;
  while (set.size < count) {
    if (draws++ >= maxDraws) {
      throw new StartupError(
        `Unable to produce ${count} unique token UUIDs after ${draws} attempts`,
      );
    }
    set.add(genId());
  }
  return [...set];
}

/**
 * Close every open history row (`released_at IS NULL`) left by a previous run.
 * Returns the number of rows reconciled.
 */
async function reconcileOpenHistory(db: Database): Promise<number> {
  const closed = await db
    .update(usageHistory)
    .set({
      releasedAt: sql`now()`,
      releaseReason: ReleaseReason.STARTUP_RECONCILIATION,
    })
    .where(isNull(usageHistory.releasedAt))
    .returning({ id: usageHistory.id });
  return closed.length;
}

/** Detect a Postgres unique-violation error (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}
