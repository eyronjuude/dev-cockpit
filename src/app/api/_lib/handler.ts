import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { AppError, errorMessage } from '@/core/errors';

/**
 * Shared route-handler plumbing.
 *
 * Every mutation goes through `handle`, so a thrown AppError becomes a clean
 * status and message, a Zod failure becomes a readable field list, and an
 * unexpected error is logged server-side without leaking a stack to the client.
 */

export interface ApiFailure {
  error: string;
  code: string;
  details?: Record<string, string[]>;
}

export async function handle<T>(
  fn: () => Promise<T> | T,
): Promise<NextResponse<T | ApiFailure>> {
  try {
    const result = await fn();
    return NextResponse.json(result as T);
  } catch (err) {
    if (err instanceof AppError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }

    if (err instanceof ZodError) {
      const details: Record<string, string[]> = {};
      for (const issue of err.issues) {
        const key = issue.path.join('.') || '_';
        (details[key] ??= []).push(issue.message);
      }
      return NextResponse.json(
        { error: 'The submitted values are not valid.', code: 'validation', details },
        { status: 400 },
      );
    }

    const message = errorMessage(err);
    console.error('[dev-cockpit] Unhandled route error:', err);
    return NextResponse.json({ error: message, code: 'internal' }, { status: 500 });
  }
}

/** Parses a JSON body, rejecting a malformed one with a clear message. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AppError('The request body must be valid JSON.');
  }
}

/**
 * Rejects requests that did not come from the local UI.
 *
 * This app drives Claude Code and shell commands on the machine, so a page in
 * another tab must not be able to trigger a run. Same-origin is enforced rather
 * than assumed: Next binds to 127.0.0.1 by default, but a browser on this
 * machine can still be pointed at it by a malicious page.
 */
export function assertLocalRequest(request: Request): void {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return;

  const origin = request.headers.get('origin');
  // A same-origin fetch from our own pages always sends Origin.
  if (!origin) {
    throw new AppError('This request must come from the Dev Cockpit UI.', {
      status: 403,
      code: 'forbidden',
    });
  }

  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    throw new AppError('Malformed Origin header.', { status: 403, code: 'forbidden' });
  }

  const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (!LOCAL_HOSTS.has(host)) {
    throw new AppError('Dev Cockpit only accepts requests from the local machine.', {
      status: 403,
      code: 'forbidden',
    });
  }
}
