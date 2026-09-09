import { describe, expect, it } from 'vitest';

import { capacityExhaustionReason, isCapacityExhaustion } from '@/agents/capacity';

describe('agent capacity detection', () => {
  it('recognises quota, credit, and rate-limit failures', () => {
    for (const message of [
      'Claude Code usage limit reached. Your limit will reset in 2 hours.',
      'No credits remaining for this session.',
      '429: too many requests',
      'Rate limit exceeded, try again later.',
    ]) {
      expect(isCapacityExhaustion(message), message).toBe(true);
      expect(capacityExhaustionReason(message)).toBe(message);
    }
  });

  it('does not treat ordinary implementation failures as capacity failures', () => {
    for (const message of [
      'TypeScript compilation failed.',
      'Permission mode refused Bash.',
      'Codex CLI produced no final message',
      'The command exited with code 1.',
    ]) {
      expect(isCapacityExhaustion(message), message).toBe(false);
      expect(capacityExhaustionReason(message)).toBeNull();
    }
  });
});
