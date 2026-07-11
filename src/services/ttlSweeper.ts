import { performance } from "node:perf_hooks";
import { ReleaseReason } from "../db/schema";
import type { TokenRegistry } from "../registry/tokenRegistry";
import type { Logger } from "../lib/logger";
import type { HistoryWriter } from "./historyWriter";

/**
 * Periodic background reclamation of active tokens that have outlived
 * `TOKEN_TTL_SECONDS` (F03). Drives the same seams F02 already built:
 * `TokenRegistry.release()` (synchronous, idempotent) for the in-memory
 * mutation, and `HistoryWriter.close()` for the durable audit close. No
 * client-facing surface — this is the only thing that mutates state on a
 * timer rather than in response to a request.
 */

export interface TtlSweeperDeps {
  readonly registry: TokenRegistry;
  readonly historyWriter: HistoryWriter;
  readonly ttlSeconds: number;
  readonly logger: Logger;
  /** Sweep tick interval in ms; overridable for tests. Defaults to 1000ms. */
  readonly intervalMs?: number;
}

export interface TtlSweeper {
  /** Schedule recurring sweeps on an unref'd timer. No-op if already started. */
  start(): void;
  /** Stop scheduling further sweeps and await any in-flight sweep. */
  stop(): Promise<void>;
  /** Run one sweep pass immediately. Never throws/rejects — failures are logged. */
  sweepOnce(): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 1000;

export function createTtlSweeper(deps: TtlSweeperDeps): TtlSweeper {
  const { registry, historyWriter, ttlSeconds, logger } = deps;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const ttlMs = ttlSeconds * 1000;

  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;

  async function sweepOnce(): Promise<void> {
    try {
      const now = performance.now();
      const releasedTokenIds: string[] = [];

      // Synchronous scan-and-release: no `await` between them, mirroring the
      // registry's synchronous-mutation invariant so a token's due-check and
      // release happen in a single event-loop turn.
      for (const entry of registry.snapshot()) {
        if (
          entry.state !== "active" ||
          !entry.active ||
          now - entry.active.activatedAtMonotonic < ttlMs
        ) {
          continue;
        }
        // `release()` is idempotent: a `null` return means another path
        // (eviction/clear-active) already released this token — skip it.
        const released = registry.release(entry.tokenId);
        if (released !== null) releasedTokenIds.push(entry.tokenId);
      }

      for (const tokenId of releasedTokenIds) {
        try {
          await historyWriter.close({
            tokenId,
            releasedAt: new Date(),
            reason: ReleaseReason.TTL,
          });
        } catch (err) {
          logger.error("TTL sweep: history close failed for a released token", {
            tokenId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      // Per-tick isolation: a thrown error here must never stop the interval
      // (PRD Error Handling: "supervised restart" — the next tick is it).
      logger.error("TTL sweep tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        inFlight = sweepOnce().finally(() => {
          inFlight = null;
        });
      }, intervalMs);
      timer.unref?.();
    },
    async stop(): Promise<void> {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await inFlight;
    },
    sweepOnce,
  };
}
