import { performance } from "node:perf_hooks";
import type { TokenRegistry } from "../registry/tokenRegistry";

/**
 * Read-only pool listing (F04). A pure projection over the in-memory
 * {@link TokenRegistry} — it adds no state, only reads `snapshot()` (seeded by
 * F01, mutated by F02) and computes each active token's remaining TTL.
 *
 * `remainingSeconds` is derived from the monotonic activation reference
 * (`activatedAtMonotonic`, stamped by F02) versus the configured TTL, so the
 * value is immune to wall-clock changes — the same measurement basis F03 uses
 * for release timing. It is floored (never overstates remaining time) and
 * clamped at 0 (a token past its TTL but not yet swept reports 0, not a
 * negative countdown).
 */

export interface ListingTokenEntry {
  readonly tokenId: string;
  readonly state: "available" | "active";
  /** Present only for active tokens. */
  readonly userId?: string;
  /** ISO-8601 wall-clock activation time; present only for active tokens. */
  readonly activatedAt?: string;
  /** Whole seconds until TTL release, clamped at 0; present only for active tokens. */
  readonly remainingSeconds?: number;
}

export interface ListingResult {
  readonly tokens: ListingTokenEntry[];
  readonly summary: { readonly available: number; readonly active: number };
}

export interface ListingServiceDeps {
  readonly registry: TokenRegistry;
  /** TTL in seconds (config `TOKEN_TTL_SECONDS`, default 120). */
  readonly ttlSeconds: number;
  /**
   * Monotonic "now" in milliseconds; defaults to `performance.now()`. Injectable
   * so the remaining-time computation can be exercised deterministically in tests
   * (spec Testing Strategy: "advance a fake/mocked performance.now()").
   */
  readonly now?: () => number;
}

export interface ListingService {
  list(): ListingResult;
}

export function createListingService(deps: ListingServiceDeps): ListingService {
  const { registry, ttlSeconds } = deps;
  const now = deps.now ?? (() => performance.now());

  return {
    list(): ListingResult {
      const nowMs = now();

      const tokens = registry.snapshot().map((entry): ListingTokenEntry => {
        if (!entry.active) {
          return { tokenId: entry.tokenId, state: entry.state };
        }
        const elapsedSeconds = (nowMs - entry.active.activatedAtMonotonic) / 1000;
        const remainingSeconds = Math.max(0, Math.floor(ttlSeconds - elapsedSeconds));
        return {
          tokenId: entry.tokenId,
          state: entry.state,
          userId: entry.active.userId,
          activatedAt: entry.active.activatedAt.toISOString(),
          remainingSeconds,
        };
      });

      // Counts come straight from the registry so they always sum to pool size.
      return {
        tokens,
        summary: { available: registry.available, active: registry.active },
      };
    },
  };
}
