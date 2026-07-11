import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { start } from "../../src/index";
import { StartupError } from "../../src/lib/errors";
import { TokenRegistry } from "../../src/registry/tokenRegistry";
import { tokens, usageHistory } from "../../src/db/schema";
import {
  countRows,
  setupTestDb,
  truncateAll,
  TEST_DATABASE_URL,
} from "../helpers/db";
import type { DbHandle } from "../../src/db/client";

let handle: DbHandle;
const started: Array<{ shutdown: () => Promise<void> }> = [];

// Capture and restore env mutated per test.
const ORIGINAL_ENV = { ...process.env };

async function boot(overrides: NodeJS.ProcessEnv = {}) {
  process.env = {
    ...ORIGINAL_ENV,
    DATABASE_URL: TEST_DATABASE_URL,
    PORT: "0", // ephemeral port to avoid clashes
    ...overrides,
  };
  const svc = await start(new TokenRegistry());
  started.push(svc);
  return svc;
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

describe("startup orchestration", () => {
  it("boots with a full pool of 100 available tokens", async () => {
    const svc = await boot();
    expect(svc.registry.size).toBe(100);
    expect(svc.registry.available).toBe(100);
    expect(svc.registry.active).toBe(0);

    expect(await countRows(handle, "tokens")).toBe(100);
  });

  it("keeps the token count at exactly 100 across restarts", async () => {
    await (await boot()).shutdown();
    started.pop();
    const svc = await boot();

    expect(await countRows(handle, "tokens")).toBe(100);
    expect(svc.registry.size).toBe(100);
  });

  it("loads the identical 100 token UUIDs on the second boot", async () => {
    const first = await boot();
    const firstIds = [...first.registry.tokenIds()].sort();
    await first.shutdown();
    started.pop();

    const second = await boot();
    const secondIds = [...second.registry.tokenIds()].sort();
    expect(secondIds).toEqual(firstIds);
  });

  it("aborts when the store cannot initialize (unreachable DB) and never listens", async () => {
    await expect(
      boot({
        DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:1/nope",
      }),
    ).rejects.toBeInstanceOf(StartupError);
  });

  it("fails fast with a message naming the port when it is already in use", async () => {
    // Occupy a concrete port with a bare server, then boot onto the same port.
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const busyPort = (blocker.address() as AddressInfo).port;

    try {
      await expect(boot({ PORT: String(busyPort) })).rejects.toThrow(
        new RegExp(`port ${busyPort}`),
      );
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("closes orphaned open history rows on boot (reconciliation)", async () => {
    const first = await boot();
    const tokenId = first.registry.tokenIds()[0]!;
    await first.shutdown();
    started.pop();

    await handle.db.insert(usageHistory).values({
      tokenId,
      userId: crypto.randomUUID(),
      startedAt: new Date(),
    });

    await boot();
    const [row] = await handle.db.select().from(usageHistory);
    expect(row?.releasedAt).not.toBeNull();
    expect(row?.releaseReason).toBe("startup_reconciliation");
  });
});

describe("cross-feature integration (F01-verifiable)", () => {
  it("registry exposes exactly the seeded tokens (F02 can only draw from these)", async () => {
    const svc = await boot();
    const rows = await handle.db.select({ id: tokens.id }).from(tokens);
    const persisted = new Set(rows.map((r) => r.id));
    const inRegistry = new Set(svc.registry.tokenIds());
    expect(inRegistry).toEqual(persisted);
    expect(inRegistry.size).toBe(100);
  });

  it("history schema accepts an assignment record referencing a seeded token", async () => {
    const svc = await boot();
    const tokenId = svc.registry.tokenIds()[0]!;

    await expect(
      handle.db.insert(usageHistory).values({
        tokenId,
        userId: crypto.randomUUID(),
        startedAt: new Date(),
      }),
    ).resolves.toBeDefined();
  });

  it("history FK rejects a row referencing a token outside the pool", async () => {
    await boot();
    await expect(
      handle.db.insert(usageHistory).values({
        tokenId: crypto.randomUUID(), // not a seeded token
        userId: crypto.randomUUID(),
        startedAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});
