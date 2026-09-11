import { describe, expect, it } from 'vitest';

import {
  CONVENTIONAL_COMMIT_TYPES,
  lintCommitSubject,
  looksConventional,
  resolveCommitConvention,
  withConventionalType,
} from '@/git/commit-message';

describe('looksConventional / withConventionalType', () => {
  it('recognises a plain conventional subject', () => {
    expect(looksConventional('feat: add dark mode')).toBe(true);
  });

  it('recognises a scoped subject', () => {
    expect(looksConventional('fix(auth): handle expired tokens')).toBe(true);
  });

  it('rejects a subject with no type prefix', () => {
    expect(looksConventional('Add dark mode')).toBe(false);
  });

  it('prefixes a plain subject with the given type', () => {
    expect(withConventionalType('Add dark mode', 'feat')).toBe('feat: Add dark mode');
  });

  it('leaves an already-conventional subject untouched', () => {
    expect(withConventionalType('fix(auth): handle expired tokens', 'feat')).toBe(
      'fix(auth): handle expired tokens',
    );
  });
});

describe('lintCommitSubject', () => {
  const convention = { types: CONVENTIONAL_COMMIT_TYPES };

  it('accepts a valid conventional subject', () => {
    const result = lintCommitSubject('feat: add dark mode', convention);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a valid scoped subject', () => {
    const result = lintCommitSubject('fix(auth): handle expired tokens', convention);
    expect(result.valid).toBe(true);
  });

  it('rejects a subject with no type prefix at all', () => {
    const result = lintCommitSubject('Add dark mode', convention);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/type\(scope\): description/);
  });

  it('rejects an unknown type, naming it', () => {
    const result = lintCommitSubject('feature: add dark mode', convention);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"feature"'))).toBe(true);
  });

  it('rejects an empty description', () => {
    const result = lintCommitSubject('feat: ', convention);
    expect(result.valid).toBe(false);
  });

  it('rejects a header past the length cap', () => {
    const longSubject = `feat: ${'x'.repeat(120)}`;
    const result = lintCommitSubject(longSubject, convention);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('exceeds 100 characters'))).toBe(true);
  });

  it('accepts a custom type list and rejects the standard one instead', () => {
    const custom = { types: ['feature', 'fixup'] };
    expect(lintCommitSubject('feature: add dark mode', custom).valid).toBe(true);
    expect(lintCommitSubject('feat: add dark mode', custom).valid).toBe(false);
  });
});

describe('resolveCommitConvention', () => {
  it('returns the built-in list for "conventional"', () => {
    const convention = resolveCommitConvention({
      commitConvention: 'conventional',
      customCommitTypes: [],
    });
    expect(convention.types).toEqual(CONVENTIONAL_COMMIT_TYPES);
  });

  it('falls back to the built-in list for "custom" with no types configured', () => {
    const convention = resolveCommitConvention({
      commitConvention: 'custom',
      customCommitTypes: [],
    });
    expect(convention.types).toEqual(CONVENTIONAL_COMMIT_TYPES);
  });

  it('returns exactly the configured list for "custom" with types set', () => {
    const convention = resolveCommitConvention({
      commitConvention: 'custom',
      customCommitTypes: ['feature', 'fixup', 'maint'],
    });
    expect(convention.types).toEqual(['feature', 'fixup', 'maint']);
  });
});
