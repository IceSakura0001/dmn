export type ErrorCode = 'VALIDATION' | 'FORBIDDEN' | 'CONFLICT' | 'NOT_FOUND' | 'TOPIC_STOPPED' | 'BUDGET_EXHAUSTED' | 'STORAGE';

/** Public errors intentionally omit submitted values, SQL and underlying exceptions. */
export class DmnError extends Error {
  constructor(public readonly code: ErrorCode, message: string) { super(message); this.name = 'DmnError'; }
}

export function fail(code: ErrorCode, message: string): never { throw new DmnError(code, message); }

export function storageError(error: unknown): never {
  if (error instanceof DmnError) throw error;
  fail('STORAGE', 'Database operation failed; no acceptance was issued.');
}
