/**
 * In-memory, process-local active-state registry (PRD Out of Scope: single
 * in-memory registry, single instance). It holds the fixed set of token UUIDs
 * and, for each, whether it is currently active plus its holder metadata.
 *
 * F01 only needs all-available initialization and the `available`/`active`
 * counts for `GET /health`. The mutation surface (activate/release/eviction)
 * is defined here as the interface F02/F03/F04/F06/F07 consume, kept minimal
 * and consistent so later features build on a stable contract.
 */

export type TokenState = "available" | "active";

export interface ActiveInfo {
  readonly userId: string;
  /** Wall-clock activation time (for history/`activatedAt` reporting). */
  readonly activatedAt: Date;
  /** Monotonic reference (ms) used by F03 for TTL, immune to clock changes. */
  readonly activatedAtMonotonic: number;
}

interface TokenEntry {
  readonly id: string;
  active: ActiveInfo | null;
}

export interface RegistrySnapshotEntry {
  readonly tokenId: string;
  readonly state: TokenState;
  readonly active: ActiveInfo | null;
}

/** The prior holder displaced by an overflow eviction (F02), so history can be closed. */
export interface EvictedHold {
  readonly tokenId: string;
  readonly info: ActiveInfo;
}

/** Outcome of a single {@link TokenRegistry.acquire}. */
export interface AcquireResult {
  readonly tokenId: string;
  readonly activatedAt: Date;
  /** Non-null when the pool was full and the oldest active token was evicted and reused. */
  readonly evicted: EvictedHold | null;
}

export class TokenRegistry {
  private readonly entries = new Map<string, TokenEntry>();
  private activeCount = 0;

  /**
   * Initialize the registry from the seeded/loaded token identity set. All
   * tokens start available (active state is lost across restarts by design).
   * Idempotent-by-replacement: a second call resets to all-available.
   */
  init(tokenIds: readonly string[]): void {
    this.entries.clear();
    this.activeCount = 0;
    for (const id of tokenIds) {
      if (this.entries.has(id)) {
        throw new Error(`Duplicate token id passed to registry.init: ${id}`);
      }
      this.entries.set(id, { id, active: null });
    }
  }

  /** Total pool size (invariant for the process lifetime). */
  get size(): number {
    return this.entries.size;
  }

  get active(): number {
    return this.activeCount;
  }

  get available(): number {
    return this.entries.size - this.activeCount;
  }

  has(tokenId: string): boolean {
    return this.entries.has(tokenId);
  }

  getState(tokenId: string): TokenState | undefined {
    const entry = this.entries.get(tokenId);
    if (!entry) return undefined;
    return entry.active ? "active" : "available";
  }

  getActiveInfo(tokenId: string): ActiveInfo | null {
    return this.entries.get(tokenId)?.active ?? null;
  }

  /** All token IDs, in insertion (seed) order. */
  tokenIds(): string[] {
    return [...this.entries.keys()];
  }

  /** A consistent point-in-time snapshot of every token's state (F04/F06). */
  snapshot(): RegistrySnapshotEntry[] {
    return [...this.entries.values()].map((e) => ({
      tokenId: e.id,
      state: e.active ? "active" : "available",
      active: e.active,
    }));
  }

  // --- Mutation surface consumed by F02/F03/F07 (defined now for stability) ---

  /** Mark a known, available token active. Throws if unknown or already active. */
  activate(tokenId: string, info: ActiveInfo): void {
    const entry = this.entries.get(tokenId);
    if (!entry) throw new Error(`Unknown token id: ${tokenId}`);
    if (entry.active) throw new Error(`Token already active: ${tokenId}`);
    entry.active = info;
    this.activeCount += 1;
  }

  /** Release a token back to available. Idempotent: releasing an available token is a no-op. */
  release(tokenId: string): ActiveInfo | null {
    const entry = this.entries.get(tokenId);
    if (!entry || !entry.active) return null;
    const prev = entry.active;
    entry.active = null;
    this.activeCount -= 1;
    return prev;
  }

  /**
   * Assign a token to a new holder (F02). Selects the first available token;
   * when none is available (pool full), evicts the **oldest** active token — the
   * one with the smallest `activatedAtMonotonic`, ties broken by seed order — and
   * reuses it in place, reporting the displaced holder as `evicted`.
   *
   * The capacity check and the mutation run in a single event-loop turn with no
   * `await`, so Node's single thread serializes concurrent callers: the active
   * count can never exceed the pool size and no token is ever handed to two users
   * at once. Callers MUST keep this method fully synchronous — introducing an
   * `await` inside it would reopen that race.
   */
  acquire(info: ActiveInfo): AcquireResult {
    let target: TokenEntry | undefined;
    for (const entry of this.entries.values()) {
      if (!entry.active) {
        target = entry;
        break;
      }
    }

    let evicted: EvictedHold | null = null;
    if (target) {
      target.active = info;
      this.activeCount += 1;
    } else {
      // Pool full → evict the oldest active token. Iterating in insertion (seed)
      // order with a strict `<` keeps the earliest-seeded token on an exact tie.
      let oldest: TokenEntry | undefined;
      for (const entry of this.entries.values()) {
        if (
          entry.active &&
          (oldest === undefined ||
            entry.active.activatedAtMonotonic < oldest.active!.activatedAtMonotonic)
        ) {
          oldest = entry;
        }
      }
      if (!oldest) {
        // No available and no active token ⇒ empty pool; unreachable at size 100.
        throw new Error("Cannot acquire a token from an empty pool");
      }
      evicted = { tokenId: oldest.id, info: oldest.active! };
      oldest.active = info; // reuse in place; active count is unchanged.
      target = oldest;
    }

    return { tokenId: target.id, activatedAt: info.activatedAt, evicted };
  }
}

/** Process-wide singleton used by the app; tests can construct their own. */
export const tokenRegistry = new TokenRegistry();
