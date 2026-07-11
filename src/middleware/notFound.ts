import type { RequestHandler } from "express";
import { NotFoundError } from "../lib/errors";

/**
 * Terminal handler for unmatched routes. Delegates to the central error
 * middleware by forwarding a {@link NotFoundError}, so the 404 body uses the
 * same standard envelope as every other error.
 */
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new NotFoundError());
};
