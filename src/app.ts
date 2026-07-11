import express, { type Express } from "express";
import type { TokenRegistry } from "./registry/tokenRegistry";
import type { HistoryWriter } from "./services/historyWriter";
import { createHealthRouter } from "./routes/health";
import { createApiRouter } from "./routes/index";
import { errorHandler } from "./middleware/errorHandler";
import { notFoundHandler } from "./middleware/notFound";

export interface AppDeps {
  readonly registry: TokenRegistry;
  readonly apiBasePath: string;
  readonly historyWriter: HistoryWriter;
  /** TTL in seconds (config `TOKEN_TTL_SECONDS`), forwarded to the API router (F04). */
  readonly ttlSeconds: number;
}

/**
 * Assemble the Express application: JSON body parsing, the root-mounted
 * `/health` route, the base-path router for future features, then the
 * not-found and central error middleware (registered last). Pure factory — it
 * performs no I/O and does not bind a port, so tests can drive it directly.
 */
export function createApp(deps: AppDeps): Express {
  const { registry, apiBasePath, historyWriter, ttlSeconds } = deps;
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json());

  // /health lives at the root, outside API_BASE_PATH (spec API Contracts).
  app.use(createHealthRouter(registry));

  // All business routes (F02+) mount under the configurable base path.
  app.use(apiBasePath, createApiRouter({ registry, historyWriter, ttlSeconds }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
