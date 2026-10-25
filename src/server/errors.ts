export class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public status = 400,
    public fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = "auth.required") {
    super(message, "UNAUTHENTICATED", 401);
  }
}

/** Use for both "missing" and "not permitted to know it exists" to avoid leaking existence. */
export class NotFoundError extends AppError {
  constructor(message = "errors.notFound") {
    super(message, "NOT_FOUND", 404);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "errors.forbidden") {
    super(message, "FORBIDDEN", 403);
  }
}

export class ValidationError extends AppError {
  constructor(message = "errors.validation", fieldErrors?: Record<string, string[]>) {
    super(message, "VALIDATION", 422, fieldErrors);
  }
}

/**
 * What a lost compare-and-set returns to the client (BUSINESS_RULES §6, CE rule 4): the current
 * values of the fields being written, which of them differ, and who changed the record last.
 */
export interface ConflictDetails {
  current: Record<string, unknown>;
  changedFields: string[];
  changedBy: { name: string; at: string } | null;
}

export class ConflictError extends AppError {
  constructor(
    message = "errors.conflict",
    public details?: ConflictDetails,
  ) {
    super(message, "CONFLICT", 409);
  }
}

export class RateLimitError extends AppError {
  constructor(message = "errors.rateLimited") {
    super(message, "RATE_LIMITED", 429);
  }
}

export function invariant(cond: unknown, message = "errors.validation"): asserts cond {
  if (!cond) throw new ValidationError(message);
}
