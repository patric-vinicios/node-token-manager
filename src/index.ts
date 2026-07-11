import type { Server } from "node:http";
import { createApp } from "./app";
import { loadConfig, type AppConfig } from "./config";
import { createDb, type DbHandle } from "./db/client";
import { runMigrations } from "./db/migrate";
import { StartupError } from "./lib/errors";
import { logger } from "./lib/logger";
import { initializePool } from "./services/poolInitializer";
import { createHistoryWriter } from "./services/historyWriter";
import { createTtlSweeper } from "./services/ttlSweeper";
import { TokenRegistry, tokenRegistry } from "./registry/tokenRegistry";

export interface StartedService {
  readonly server: Server;
  readonly db: DbHandle;
  readonly registry: TokenRegistry;
  readonly config: AppConfig;
  /** Gracefully close the HTTP server and DB pool. */
  shutdown(): Promise<void>;
}

/**
 * Full startup sequence (spec Architecture): load config → connect/migrate DB →
 * seed/load pool → init registry → reconcile history → bind HTTP port. Any step
 * failing aborts before the server listens, so traffic is never accepted in a
 * degraded state (PRD F01).
 *
 * @param registry Injectable for tests; defaults to the process singleton.
 */
export async function start(
  registry: TokenRegistry = tokenRegistry,
): Promise<StartedService> {
  const config = loadConfig();

  // 1. Connect to the durable store and verify connectivity, fail-fast.
  const db = createDb(config.DATABASE_URL);
  try {
    await db.ping();
  } catch (err) {
    await db.close().catch(() => undefined);
    throw new StartupError(
      "PostgreSQL history store: unable to connect (check DATABASE_URL)",
      err,
    );
  }

  try {
    // 2. Apply migrations (creates tokens + usage_history if absent).
    await runMigrations(db.db);

    // 3. Seed-or-load the fixed pool, then reconcile orphaned history.
    const { tokenIds } = await initializePool({
      db: db.db,
      poolSize: config.POOL_SIZE,
      logger,
    });

    // 4. Initialize the in-memory registry to all-available.
    registry.init(tokenIds);
  } catch (err) {
    await db.close().catch(() => undefined);
    throw err;
  }

  // 5. Bind the HTTP port (fail-fast on port-in-use).
  const historyWriter = createHistoryWriter({ db: db.db, logger });
  const app = createApp({
    registry,
    apiBasePath: config.API_BASE_PATH,
    historyWriter,
    db: db.db,
  });
  const server = await listen(app, config.PORT);

  // 6. Start the background TTL sweeper (F03) now that the registry and
  // history writer are ready.
  const ttlSweeper = createTtlSweeper({
    registry,
    historyWriter,
    ttlSeconds: config.TOKEN_TTL_SECONDS,
    logger,
  });
  ttlSweeper.start();

  logger.info(`Token pool initialized: ${registry.available} available`, {
    available: registry.available,
    active: registry.active,
    poolSize: config.POOL_SIZE,
    port: config.PORT,
    basePath: config.API_BASE_PATH,
  });

  const shutdown = async (): Promise<void> => {
    // Stop accepting requests, stop the TTL sweeper, drain any buffered
    // history writes, then close the DB.
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await ttlSweeper.stop();
    await historyWriter.stop();
    await db.close();
  };

  return { server, db, registry, config, shutdown };
}

/** Promisified `app.listen` that rejects with a port-naming StartupError on EADDRINUSE. */
function listen(app: ReturnType<typeof createApp>, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port);
    server.once("listening", () => {
      server.removeListener("error", onError);
      resolve(server);
    });
    server.once("error", onError);

    function onError(err: NodeJS.ErrnoException) {
      if (err.code === "EADDRINUSE") {
        reject(new StartupError(`HTTP port ${port} is already in use`, err));
      } else {
        reject(new StartupError(`Failed to bind HTTP port ${port}`, err));
      }
    }
  });
}

// Auto-start only when run directly (not when imported by tests).
if (require.main === module) {
  start().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Startup failed; service will not accept traffic", {
      error: message,
      cause:
        err instanceof StartupError && err.cause instanceof Error
          ? err.cause.message
          : undefined,
    });
    process.exit(1);
  });
}
