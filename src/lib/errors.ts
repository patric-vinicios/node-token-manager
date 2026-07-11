/**
 * Typed application errors and the shared error-code catalog.
 *
 * F01 establishes the standard JSON error envelope reused by every later
 * feature (F02+). The central error middleware maps an {@link AppError} (or an
 * unknown throw) into `{ status: "error", error: { code, message } }`.
 */

/** App-level error codes. Values double as the `code` in the error envelope. */
export const ErrorCode = {
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Default HTTP status for each known code. */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.INTERNAL_ERROR]: 500,
};

/**
 * Base class for expected, client-facing errors. Carries an {@link ErrorCode}
 * and an HTTP status so the error middleware can serialize it consistently.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;

  constructor(code: ErrorCode, message: string, statusCode?: number) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode ?? STATUS_BY_CODE[code];
    Error.captureStackTrace?.(this, new.target);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Route not found") {
    super(ErrorCode.NOT_FOUND, message);
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed") {
    super(ErrorCode.VALIDATION_ERROR, message);
  }
}

/**
 * Fatal startup error. Not client-facing (the service never listens when one is
 * thrown); it names the failed subsystem so operators can act (PRD F01).
 */
export class StartupError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "StartupError";
    this.cause = cause;
  }
}
