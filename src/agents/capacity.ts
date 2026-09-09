/**
 * Detects provider failures that are worth trying on another implementation
 * agent instead of treating as a normal implementation failure.
 *
 * This deliberately stays conservative. A syntax error, failed tool call, or
 * rejected prompt may still leave useful partial work to validate. Quota,
 * credits, and rate-limit failures usually mean the model never had capacity
 * to do the work, so those can move to a fallback or pause for later.
 */

const CAPACITY_PATTERNS: readonly RegExp[] = [
  /\b429\b/i,
  /\brate[-\s]?limit(?:ed)?\b/i,
  /\bquota\b/i,
  /\bcredit(?:s)?\b/i,
  /\busage\s+limit\b/i,
  /\blimit\s+(?:has\s+)?(?:been\s+)?(?:reached|exceeded)\b/i,
  /\bexhausted\b/i,
  /\btoo\s+many\s+requests\b/i,
  /\btry\s+again\s+(?:later|in)\b/i,
  /\b(?:reset|resets|refresh|refreshes)\s+(?:at|in|after)\b/i,
  /\bwait\s+\d+\s*(?:second|minute|hour|day)s?\b/i,
];

export function capacityExhaustionReason(message: string | null | undefined): string | null {
  const text = message?.trim();
  if (!text) return null;
  return CAPACITY_PATTERNS.some((pattern) => pattern.test(text)) ? text : null;
}

export function isCapacityExhaustion(message: string | null | undefined): boolean {
  return capacityExhaustionReason(message) !== null;
}
