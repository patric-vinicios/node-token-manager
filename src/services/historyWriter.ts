import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { ReleaseReason, usageHistory } from "../db/schema";
import type { Logger } from "../lib/logger";

/**
 * Durable writer for the `usage_history` audit trail (F02 *Provides* → F05).
 *
 * On every assignment it opens a new hold row (`released_at IS NULL`). When the
 * assignment evicted a full pool's oldest token, the token's existing open row
 * is closed (`released_at = now`, `release_reason = 'eviction'`) and the new one
 * opened **in a single transaction**, so a token never has two open rows and the
 * close is never dropped.
 *
 * Durability is deliberately kept off the assignment critical path: {@link
 * HistoryWriter.record} is awaited on the happy path, but a DB failure never
 * rejects — the event is handed to a bounded in-memory retry buffer with
 * exponential backoff, and only a permanently exhausted event is dropped (logged).
 * This upholds the PRD guarantee that a history-store outage never blocks or
 * fails an assignment.
 */

export interface HistoryRecordInput {
  readonly tokenId: string;
  readonly userId: string;
  /** Assignment instant; used as the new row's `started_at` and the evicted row's `released_at`. */
  readonly startedAt: Date;
  /** True when this assignment evicted the token's previous holder (close-then-open). */
  readonly evicted: boolean;
}

export interface HistoryCloseInput {
  readonly tokenId: string;
  /** Instant the hold ended; written to the open row's `released_at`. */
  readonly releasedAt: Date;
  readonly reason: ReleaseReason;
}

export interface HistoryWriter {
  /** Persist one assignment event. Never rejects; buffers on failure. */
  record(input: HistoryRecordInput): Promise<void>;
  /**
   * Close a token's already-open hold without opening a new one (F03 TTL
   * release, distinct from F02's close-then-open eviction path). Never
   * rejects; buffers on failure. Ordered on the same per-token chain as
   * {@link record}, so a close is never applied after a later open it
   * should have preceded.
   */
  close(input: HistoryCloseInput): Promise<void>;
  /** Best-effort drain of any buffered events (used on graceful shutdown). */
  flush(): Promise<void>;
  /** Stop retrying, drain the buffer, and release timers. */
  stop(): Promise<void>;
}

export interface HistoryWriterOptions {
  /** Max events held in the retry buffer; the oldest is dropped (logged) when exceeded. */
  readonly maxBufferSize?: number;
  /** First retry delay; doubles each attempt up to {@link maxBackoffMs}. */
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Attempts (including the initial write) before an event is abandoned. */
  readonly maxAttempts?: number;
}

export interface HistoryWriterDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly options?: HistoryWriterOptions;
}

/** A pending write, tagged so a single retry buffer can carry either kind. */
type Operation =
  | ({ readonly kind: "record" } & HistoryRecordInput)
  | ({ readonly kind: "close" } & HistoryCloseInput);

interface BufferedEvent {
  readonly op: Operation;
  attempts: number;
  /** `Date.now()` after which this event is eligible for another attempt. */
  nextAttemptAt: number;
}

const DEFAULTS: Required<HistoryWriterOptions> = {
  maxBufferSize: 10_000,
  baseBackoffMs: 500,
  maxBackoffMs: 30_000,
  maxAttempts: 8,
};

class DbHistoryWriter implements HistoryWriter {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly opts: Required<HistoryWriterOptions>;
  private readonly buffer: BufferedEvent[] = [];
  /** Per-token write chain: keeps same-token writes ordered (see {@link record}). */
  private readonly tokenChains = new Map<string, Promise<void>>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(deps: HistoryWriterDeps) {
    this.db = deps.db;
    this.logger = deps.logger;
    this.opts = { ...DEFAULTS, ...deps.options };
  }

  async record(input: HistoryRecordInput): Promise<void> {
    return this.enqueueOnChain({ kind: "record", ...input });
  }

  async close(input: HistoryCloseInput): Promise<void> {
    return this.enqueueOnChain({ kind: "close", ...input });
  }

  /**
   * Serialize writes per token: an eviction's close-then-open must never race
   * ahead of the previous holder's open insert, and a TTL close must never be
   * applied after a reassignment that logically followed it (which would
   * transiently leave two open rows, or close the wrong holder's row).
   * Writes for different tokens still run concurrently.
   */
  private enqueueOnChain(op: Operation): Promise<void> {
    const prev = this.tokenChains.get(op.tokenId);
    const run = (prev ?? Promise.resolve()).then(() => this.attempt(op));
    this.tokenChains.set(op.tokenId, run);
    // Bound the map: drop the chain once this write is the tail.
    void run.finally(() => {
      if (this.tokenChains.get(op.tokenId) === run) {
        this.tokenChains.delete(op.tokenId);
      }
    });
    return run;
  }

  /** One write attempt; never rejects (failures go to the retry buffer). */
  private async attempt(op: Operation): Promise<void> {
    try {
      await this.persist(op);
    } catch (err) {
      this.logger.error(
        op.kind === "record"
          ? "History write failed; buffering for retry"
          : "History close failed; buffering for retry",
        {
          tokenId: op.tokenId,
          ...(op.kind === "record" ? { userId: op.userId, evicted: op.evicted } : { reason: op.reason }),
          error: err instanceof Error ? err.message : String(err),
        },
      );
      this.enqueue({
        op,
        attempts: 1,
        nextAttemptAt: Date.now() + this.backoff(1),
      });
    }
  }

  async flush(): Promise<void> {
    this.clearTimer();
    const pending = this.buffer.splice(0, this.buffer.length);
    for (const event of pending) {
      try {
        await this.persist(event.op);
      } catch (err) {
        this.logger.error("History event lost during flush", {
          tokenId: event.op.tokenId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.flush();
  }

  /** The single write; a transaction is used only when a prior open row must also be closed. */
  private async persist(op: Operation): Promise<void> {
    if (op.kind === "close") {
      // Single UPDATE, no transaction: unlike the eviction path there is no
      // companion insert to keep atomic with the close.
      await this.db
        .update(usageHistory)
        .set({ releasedAt: op.releasedAt, releaseReason: op.reason })
        .where(and(eq(usageHistory.tokenId, op.tokenId), isNull(usageHistory.releasedAt)));
      return;
    }
    if (op.evicted) {
      await this.db.transaction(async (tx) => {
        await tx
          .update(usageHistory)
          .set({ releasedAt: op.startedAt, releaseReason: ReleaseReason.EVICTION })
          .where(and(eq(usageHistory.tokenId, op.tokenId), isNull(usageHistory.releasedAt)));
        await tx.insert(usageHistory).values({
          tokenId: op.tokenId,
          userId: op.userId,
          startedAt: op.startedAt,
        });
      });
    } else {
      await this.db.insert(usageHistory).values({
        tokenId: op.tokenId,
        userId: op.userId,
        startedAt: op.startedAt,
      });
    }
  }

  private enqueue(event: BufferedEvent): void {
    if (this.buffer.length >= this.opts.maxBufferSize) {
      const dropped = this.buffer.shift();
      this.logger.error("History retry buffer full; dropping oldest event", {
        tokenId: dropped?.op.tokenId,
      });
    }
    this.buffer.push(event);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer || this.buffer.length === 0) return;
    let soonest = Infinity;
    for (const e of this.buffer) soonest = Math.min(soonest, e.nextAttemptAt);
    const delay = Math.max(0, soonest - Date.now());
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.drainDue();
    }, delay);
    // Do not keep the process alive solely for a pending retry.
    this.retryTimer.unref?.();
  }

  private async drainDue(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    const due = this.buffer.filter((e) => e.nextAttemptAt <= now);
    for (const event of due) {
      const idx = this.buffer.indexOf(event);
      if (idx >= 0) this.buffer.splice(idx, 1);
      try {
        await this.persist(event.op);
      } catch (err) {
        event.attempts += 1;
        if (event.attempts >= this.opts.maxAttempts) {
          this.logger.error("History event permanently failed; dropping after retries", {
            tokenId: event.op.tokenId,
            attempts: event.attempts,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        event.nextAttemptAt = Date.now() + this.backoff(event.attempts);
        this.buffer.push(event);
      }
    }
    this.scheduleRetry();
  }

  private backoff(attempt: number): number {
    const exp = this.opts.baseBackoffMs * 2 ** (attempt - 1);
    return Math.min(exp, this.opts.maxBackoffMs);
  }

  private clearTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

export function createHistoryWriter(deps: HistoryWriterDeps): HistoryWriter {
  return new DbHistoryWriter(deps);
}
