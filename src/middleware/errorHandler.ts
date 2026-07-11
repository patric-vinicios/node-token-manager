import type { ErrorRequestHandler } from "express";
import { AppError, ErrorCode } from "../lib/errors";
import { logger } from "../lib/logger";

/** Body of a malformed JSON payload rejected by the body parser. */
function isBodyParserSyntaxError(err: unknown): boolean {
  return (
    err instanceof SyntaxError &&
    "status" in err &&
    (err as { status?: number }).status === 400 &&
    "body" in err
  );
}

/**
 * Central error-handling middleware. Maps a thrown error to the standard JSON
 * envelope `{ status: "error", error: { code, message } }` and an HTTP status.
 * Known {@link AppError}s pass through their code/message; malformed JSON becomes
 * a 400 VALIDATION_ERROR; everything else is a 500 INTERNAL_ERROR with a generic
 * message (details are logged, never leaked to the client).
 *
 * Must be registered last, and must keep all four args so Express treats it as
 * error-handling middleware.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      status: "error",
      error: { code: err.code, message: err.message },
    });
    return;
  }

  if (isBodyParserSyntaxError(err)) {
    res.status(400).json({
      status: "error",
      error: { code: ErrorCode.VALIDATION_ERROR, message: "Malformed JSON request body" },
    });
    return;
  }

  logger.error("Unhandled request error", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  res.status(500).json({
    status: "error",
    error: { code: ErrorCode.INTERNAL_ERROR, message: "Internal server error" },
  });
};
