import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../src/db/client";
import { tokens, usageHistory } from "../../src/db/schema";
import { StartupError } from "../../src/lib/errors";
import { logger } from "../../src/lib/logger";
import {
  generateUniqueIds,
  initializePool,
} from "../../src/services/poolInitializer";
import { countRows, setupTestDb, truncateAll } from "../helpers/db";

let handle: DbHandle;

const silentLogger = { ...logger, info: () => {}, warn: () => {}, error: () => {} };

beforeEach(async () => {
  handle = handle ?? (await setupTestDb());
  await truncateAll(handle);
});

afterAll(async () => {
  await handle?.close();
});

describe("generateUniqueIds", () => {
  it("regenerates on duplicate ids from the generator", () => {
    // A generator that emits each value twice; the seeder must de-dup.
    const source = Array.from({ length: 100 }, () => randomUUID());
    const stream = source.flatMap((id) => [id, id]);
    let i = 0;
    const genId = () => stream[i++]!;

    const result = generateUniqueIds(100, genId);
    expect(result).toHaveLength(100);
    expect(new Set(result).size).toBe(100);
    // Consumed more than 100 draws because of the injected duplicates.
    expect(i).toBeGreaterThan(100);
  });

  it("aborts fatally when a unique set cannot be produced", () => {
    const constant = randomUUID();
    expect(() => generateUniqueIds(100, () => constant)).toThrow(StartupError);
  });
});

describe("initializePool", () => {
  it("seeds 100 unique tokens on an empty pool", async () => {
    const result = await initializePool({
      db: handle.db,
      poolSize: 100,
      logger: silentLogger,
    });
    expect(result.seeded).toBe(true);
    expect(result.tokenIds).toHaveLength(100);
    expect(new Set(result.tokenIds).size).toBe(100);

    const rows = await handle.db.select({ id: tokens.id }).from(tokens);
    expect(rows).toHaveLength(100);
  });

  it("reloads an existing pool without reseeding", async () => {
    const first = await initializePool({
      db: handle.db,
      poolSize: 100,
      logger: silentLogger,
    });
    const second = await initializePool({
      db: handle.db,
      poolSize: 100,
      logger: silentLogger,
    });

    expect(second.seeded).toBe(false);
    expect([...second.tokenIds].sort()).toEqual([...first.tokenIds].sort());

    expect(await countRows(handle, "tokens")).toBe(100);
  });

  it("aborts on a partial/inconsistent pool", async () => {
    await handle.db.insert(tokens).values([{ id: randomUUID() }]);
    await expect(
      initializePool({ db: handle.db, poolSize: 100, logger: silentLogger }),
    ).rejects.toThrow(/Inconsistent token pool/);

    // No reseed / resize occurred.
    expect(await countRows(handle, "tokens")).toBe(1);
  });

  it("reconciles orphaned open history entries at startup", async () => {
    // Seed a pool, then open a dangling history row (released_at IS NULL).
    const { tokenIds } = await initializePool({
      db: handle.db,
      poolSize: 100,
      logger: silentLogger,
    });
    await handle.db.insert(usageHistory).values({
      tokenId: tokenIds[0]!,
      userId: randomUUID(),
      startedAt: new Date(),
    });

    const result = await initializePool({
      db: handle.db,
      poolSize: 100,
      logger: silentLogger,
    });
    expect(result.reconciledOpenEntries).toBe(1);

    const [row] = await handle.db.select().from(usageHistory);
    expect(row?.releasedAt).not.toBeNull();
    expect(row?.releaseReason).toBe("startup_reconciliation");
  });
});
