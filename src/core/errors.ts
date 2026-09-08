/** An error the UI can show verbatim: no stack, no internals. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, opts: { status?: number; code?: string } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = opts.status ?? 400;
    this.code = opts.code ?? 'bad_request';
  }
}

export const notFound = (what: string) =>
  new AppError(`${what} not found`, { status: 404, code: 'not_found' });

export const conflict = (message: string) =>
  new AppError(message, { status: 409, code: 'conflict' });

export const invalid = (message: string) =>
  new AppError(message, { status: 400, code: 'invalid' });

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
