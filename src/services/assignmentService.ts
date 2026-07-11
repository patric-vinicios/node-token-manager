import { performance } from "node:perf_hooks";
import type { ActiveInfo, TokenRegistry } from "../registry/tokenRegistry";
import type { HistoryWriter } from "./historyWriter";

/**
 * Orchestrates a single token assignment (F02). It stamps the activation times,
 * performs the **synchronous** registry acquire (the atomic 100-cap enforcement
 * point), then records the durable history event.
 *
 * The history write is awaited but can never fail the request: the writer
 * swallows DB errors into its retry buffer, so `assign` always resolves with a
 * token — honoring the PRD guarantee that assignment never fails due to capacity
 * or a history-store outage.
 */

export interface AssignmentResult {
  readonly tokenId: string;
  readonly userId: string;
  /** ISO-8601 wall-clock activation time; the reference point for F03's TTL. */
  readonly activatedAt: string;
}

export interface AssignmentServiceDeps {
  readonly registry: TokenRegistry;
  readonly historyWriter: HistoryWriter;
}

export interface AssignmentService {
  assign(userId: string): Promise<AssignmentResult>;
}

export function createAssignmentService(deps: AssignmentServiceDeps): AssignmentService {
  const { registry, historyWriter } = deps;

  return {
    async assign(userId: string): Promise<AssignmentResult> {
      const activatedAt = new Date();
      const info: ActiveInfo = {
        userId,
        activatedAt,
        // Monotonic clock so eviction order and F03's TTL are immune to clock changes.
        activatedAtMonotonic: performance.now(),
      };

      // Fully synchronous: no `await` between capacity check and mutation, so
      // Node serializes concurrent callers and the active count never exceeds 100.
      const { tokenId, evicted } = registry.acquire(info);

      await historyWriter.record({
        tokenId,
        userId,
        startedAt: activatedAt,
        evicted: evicted !== null,
      });

      return { tokenId, userId, activatedAt: activatedAt.toISOString() };
    },
  };
}
