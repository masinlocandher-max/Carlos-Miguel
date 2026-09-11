/**
 * Jewel OS - typed error taxonomy.
 * Errors are part of the capability contract: callers branch on `code`,
 * never on message text.
 */

export class JewelError extends Error {
  /**
   * @param {string} code stable machine-readable code
   * @param {string} message human-readable, safe to log (never contains secrets)
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'JewelError';
    this.code = code;
    this.details = details;
    this.retryable = false;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details, retryable: this.retryable };
  }
}

export class SealError extends JewelError {
  constructor(message, details) { super('SEAL_VIOLATION', message, details); this.name = 'SealError'; }
}

export class PolicyError extends JewelError {
  constructor(message, details) { super('POLICY_DENIED', message, details); this.name = 'PolicyError'; }
}

export class ApprovalRequiredError extends JewelError {
  constructor(message, details) { super('APPROVAL_REQUIRED', message, details); this.name = 'ApprovalRequiredError'; }
}

export class AuthError extends JewelError {
  constructor(message, details) { super('UNAUTHENTICATED', message, details); this.name = 'AuthError'; }
}

export class AuthorizationError extends JewelError {
  constructor(message, details) { super('UNAUTHORIZED', message, details); this.name = 'AuthorizationError'; }
}

export class ValidationError extends JewelError {
  constructor(message, details) { super('INVALID_INPUT', message, details); this.name = 'ValidationError'; }
}

export class ProviderError extends JewelError {
  /** @param {boolean} retryable */
  constructor(message, details, retryable = false) {
    super('PROVIDER_FAILURE', message, details);
    this.name = 'ProviderError';
    this.retryable = retryable;
  }
}

export class NotFoundError extends JewelError {
  constructor(message, details) { super('NOT_FOUND', message, details); this.name = 'NotFoundError'; }
}

/** Normalize any thrown value into a JewelError without leaking stack internals. */
export function toJewelError(err) {
  if (err instanceof JewelError) return err;
  if (err instanceof Error) {
    const e = new JewelError('INTERNAL_ERROR', err.message);
    e.cause = err;
    return e;
  }
  return new JewelError('INTERNAL_ERROR', String(err));
}
