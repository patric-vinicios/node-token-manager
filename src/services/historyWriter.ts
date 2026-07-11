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

export interface HistoryWriter {
  /** Persist one assignment event. Never rejects; buffers on failure. */
  record(input: HistoryRecordInput): Promise<void>;
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

interface BufferedEvent extends HistoryRecordInput {
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
    // Serialize writes per token: an eviction reuses a token in place, so its
    // close-then-open must never race ahead of the previous holder's open insert
    // (which would transiently leave two open rows for one token). Writes for
    // different tokens still run concurrently.
    const prev = this.tokenChains.get(input.tokenId);
    const run = (prev ?? Promise.resolve()).then(() => this.attempt(input));
    this.tokenChains.set(input.tokenId, run);
    // Bound the map: drop the chain once this write is the tail.
    void run.finally(() => {
      if (this.tokenChains.get(input.tokenId) === run) {
        this.tokenChains.delete(input.tokenId);
      }
    });
    return run;
  }

  /** One write attempt; never rejects (failures go to the retry buffer). */
  private async attempt(input: HistoryRecordInput): Promise<void> {
    try {
      await this.persist(input);
    } catch (err) {
      this.logger.error("History write failed; buffering for retry", {
        tokenId: input.tokenId,
        userId: input.userId,
        evicted: input.evicted,
        error: err instanceof Error ? err.message : String(err),
      });
      this.enqueue({
        ...input,
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
        await this.persist(event);
      } catch (err) {
        this.logger.error("History event lost during flush", {
          tokenId: event.tokenId,
          userId: event.userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.flush();
  }

  /** The single write, in a transaction only when a prior open row must be closed. */
  private async persist(input: HistoryRecordInput): Promise<void> {
    if (input.evicted) {
      await this.db.transaction(async (tx) => {
        await tx
          .update(usageHistory)
          .set({ releasedAt: input.startedAt, releaseReason: ReleaseReason.EVICTION })
          .where(
            and(eq(usageHistory.tokenId, input.tokenId), isNull(usageHistory.releasedAt)),
          );
        await tx.insert(usageHistory).values({
          tokenId: input.tokenId,
          userId: input.userId,
          startedAt: input.startedAt,
        });
      });
    } else {
      await this.db.insert(usageHistory).values({
        tokenId: input.tokenId,
        userId: input.userId,
        startedAt: input.startedAt,
      });
    }
  }

  private enqueue(event: BufferedEvent): void {
    if (this.buffer.length >= this.opts.maxBufferSize) {
      const dropped = this.buffer.shift();
      this.logger.error("History retry buffer full; dropping oldest event", {
        tokenId: dropped?.tokenId,
        userId: dropped?.userId,
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
        await this.persist(event);
      } catch (err) {
        event.attempts += 1;
        if (event.attempts >= this.opts.maxAttempts) {
          this.logger.error("History event permanently failed; dropping after retries", {
            tokenId: event.tokenId,
            userId: event.userId,
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
