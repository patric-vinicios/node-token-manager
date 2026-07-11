import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { start } from "../../src/index";
import { TokenRegistry } from "../../src/registry/tokenRegistry";
import { tokens } from "../../src/db/schema";
import { setupTestDb, truncateAll, TEST_DATABASE_URL } from "../helpers/db";
import type { DbHandle } from "../../src/db/client";
import type { StartedService } from "../../src/index";

let handle: DbHandle;
const started: StartedService[] = [];
const ORIGINAL_ENV = { ...process.env };

async function boot(): Promise<StartedService> {
  process.env = { ...ORIGINAL_ENV, DATABASE_URL: TEST_DATABASE_URL, PORT: "0" };
  const svc = await start(new TokenRegistry());
  started.push(svc);
  return svc;
}

interface ListingEntry {
  tokenId: string;
  state: "available" | "active";
  userId?: string;
  activatedAt?: string;
  remainingSeconds?: number;
}
interface ListingBody {
  tokens: ListingEntry[];
  summary: { available: number; active: number };
}

async function assign(svc: StartedService, userId = randomUUID()) {
  const res = await request(svc.server).post("/api/tokens").send({ userId });
  return { userId, body: res.body as { tokenId: string; activatedAt: string } };
}

beforeEach(async () => {
  handle = handle ?? (await setupTestDb());
  await truncateAll(handle);
});

afterEach(async () => {
  while (started.length) {
    await started.pop()!.shutdown().catch(() => undefined);
  }
  process.env = { ...ORIGINAL_ENV };
});

afterAll(async () => {
  await handle?.close();
});

describe("GET /api/tokens — listing (F04)", () => {
  it("lists all 100 tokens with their correct states", async () => {
    const svc = await boot();
    const seeded = new Set(
      (await handle.db.select({ id: tokens.id }).from(tokens)).map((r) => r.id),
    );

    const res = await request(svc.server).get("/api/tokens");
    expect(res.status).toBe(200);
    const body = res.body as ListingBody;

    expect(body.tokens).toHaveLength(100);
    const ids = body.tokens.map((t) => t.tokenId);
    expect(new Set(ids).size).toBe(100); // all unique
    for (const t of body.tokens) {
      expect(seeded.has(t.tokenId)).toBe(true);
      expect(t.state).toBe("available"); // freshly booted → nothing active
    }
  });

  it("active token entries include current user and remaining time", async () => {
    const svc = await boot();
    const { userId, body: assignBody } = await assign(svc);

    const res = await request(svc.server).get("/api/tokens");
    const body = res.body as ListingBody;

    const entry = body.tokens.find((t) => t.tokenId === assignBody.tokenId)!;
    expect(entry.state).toBe("active");
    expect(entry.userId).toBe(userId);
    expect(entry.activatedAt).toBe(assignBody.activatedAt);
    expect(entry.remainingSeconds).toBeTypeOf("number");
    expect(Number.isInteger(entry.remainingSeconds)).toBe(true);
    expect(entry.remainingSeconds!).toBeGreaterThan(0);
    expect(entry.remainingSeconds!).toBeLessThanOrEqual(svc.config.TOKEN_TTL_SECONDS);

    // Available entries carry none of the active-only fields.
    const available = body.tokens.find((t) => t.state === "available")!;
    expect(available.userId).toBeUndefined();
    expect(available.activatedAt).toBeUndefined();
    expect(available.remainingSeconds).toBeUndefined();
  });

  it("summary available and active counts sum to exactly 100", async () => {
    const svc = await boot();
    const n = 7;
    for (let i = 0; i < n; i++) await assign(svc);

    const res = await request(svc.server).get("/api/tokens");
    const body = res.body as ListingBody;

    expect(body.summary.active).toBe(n);
    expect(body.summary.available).toBe(100 - n);
    expect(body.summary.available + body.summary.active).toBe(100);
  });
});

describe("cross-feature integration (F04)", () => {
  it("listing reflects registry state and active assignments (F01↔F02↔F04)", async () => {
    const svc = await boot();
    for (let i = 0; i < 15; i++) await assign(svc);

    const res = await request(svc.server).get("/api/tokens");
    const body = res.body as ListingBody;

    for (const entry of body.tokens) {
      // State matches the registry (F01).
      expect(entry.state).toBe(svc.registry.getState(entry.tokenId));
      const info = svc.registry.getActiveInfo(entry.tokenId);
      if (entry.state === "active") {
        // Active holder/activation matches the assignment (F02).
        expect(info).not.toBeNull();
        expect(entry.userId).toBe(info!.userId);
        expect(entry.activatedAt).toBe(info!.activatedAt.toISOString());
      } else {
        expect(info).toBeNull();
        expect(entry.userId).toBeUndefined();
      }
    }
  });

  it("eviction is visible in the next listing (F02↔F04)", async () => {
    const svc = await boot();

    // Fill the pool; the first assignment holds the oldest token.
    let oldestTokenId = "";
    let evictedUser = "";
    for (let i = 0; i < 100; i++) {
      const { userId, body } = await assign(svc);
      if (i === 0) {
        oldestTokenId = body.tokenId;
        evictedUser = userId;
      }
    }
    expect(svc.registry.active).toBe(100);

    // The 101st assignment evicts and reuses the oldest token.
    const { userId: newUser } = await assign(svc);

    const res = await request(svc.server).get("/api/tokens");
    const body = res.body as ListingBody;

    const entry = body.tokens.find((t) => t.tokenId === oldestTokenId)!;
    expect(entry.state).toBe("active");
    expect(entry.userId).toBe(newUser);
    expect(entry.userId).not.toBe(evictedUser);
    expect(body.summary.active).toBe(100);
    expect(body.summary.available).toBe(0);
  });
});
