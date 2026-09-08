import { afterEach, describe, expect, it } from 'vitest';

import { redact, redactText, resetEnvironmentSecretCache } from '@/core/redact';

describe('redact', () => {
  afterEach(() => {
    resetEnvironmentSecretCache();
  });

  it('masks an Anthropic key and reports the pattern that fired', () => {
    const result = redact('using ANTHROPIC key sk-ant-api03-AbCdEf1234567890XyZaBcDeFg done');
    expect(result.text).not.toContain('sk-ant-api03');
    expect(result.text).toContain('[redacted]');
    expect(result.hits).toContain('anthropic-key');
  });

  it('masks GitHub tokens', () => {
    const out = redactText('token=ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(out).not.toContain('ghp_abcdefghij');
  });

  it('masks AWS access key ids', () => {
    const out = redactText('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('keeps the key name but masks the value of a named secret', () => {
    const out = redactText('DATABASE_PASSWORD=hunter2hunter2');
    expect(out).toContain('DATABASE_PASSWORD=');
    expect(out).not.toContain('hunter2hunter2');
  });

  it('masks credentials embedded in a connection string', () => {
    const out = redactText('postgres://admin:s3cr3tpassword@db.internal:5432/app');
    expect(out).not.toContain('s3cr3tpassword');
    expect(out).toContain('postgres://');
    // The host must survive: it is diagnostic information, not a secret.
    expect(out).toContain('db.internal:5432/app');
  });

  it('masks a bearer token but keeps the scheme', () => {
    const out = redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456');
    expect(out).toContain('Bearer [redacted]');
    expect(out).not.toContain('abcdefghijklmnop');
  });

  it('masks a whole PEM private key block', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAxyz',
      'abc123',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = redactText(`before\n${pem}\nafter`);
    expect(out).not.toContain('MIIEowIBAAKCAQEAxyz');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('masks a value taken from the current environment', () => {
    process.env.DEV_COCKPIT_TEST_SECRET_TOKEN = 'zzz-super-secret-value-1234';
    resetEnvironmentSecretCache();
    try {
      const out = redactText('the build printed zzz-super-secret-value-1234 in its log');
      expect(out).not.toContain('zzz-super-secret-value-1234');
      expect(out).toContain('the build printed');
    } finally {
      delete process.env.DEV_COCKPIT_TEST_SECRET_TOKEN;
      resetEnvironmentSecretCache();
    }
  });

  it('leaves ordinary output untouched', () => {
    const text = 'src/app/page.tsx:12:5 - error TS2322: Type "string" is not assignable.';
    expect(redactText(text)).toBe(text);
  });

  it('does not mangle a normal test failure containing an equals sign', () => {
    const text = 'expected count=3 but received count=4';
    expect(redactText(text)).toBe(text);
  });

  it('handles an empty string', () => {
    expect(redactText('')).toBe('');
  });
});
