import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  claudePermissionArgs,
  PERMISSION_MODE_ENV,
  resolvePermissionMode,
} from '@/agents/permissions';
import { DEFAULT_AGENT_PERMISSION_MODE, permissionModeAllowsCommands } from '@/domain/types';

/**
 * These assertions are about a headless run never stopping to ask. The flags
 * are the whole mechanism, so they are pinned here rather than trusted.
 */

// The developer's own machine may have the override exported, which would
// otherwise decide the answers here.
const original = process.env[PERMISSION_MODE_ENV];

beforeEach(() => {
  delete process.env[PERMISSION_MODE_ENV];
});

afterAll(() => {
  if (original === undefined) delete process.env[PERMISSION_MODE_ENV];
  else process.env[PERMISSION_MODE_ENV] = original;
});

describe('resolvePermissionMode', () => {
  it('defaults to bypassing permissions when nothing is configured', () => {
    expect(resolvePermissionMode(undefined)).toBe('bypassPermissions');
    expect(resolvePermissionMode(null)).toBe('bypassPermissions');
    expect(resolvePermissionMode('  ')).toBe('bypassPermissions');
    expect(DEFAULT_AGENT_PERMISSION_MODE).toBe('bypassPermissions');
  });

  it('keeps a mode the project chose deliberately', () => {
    expect(resolvePermissionMode('acceptEdits')).toBe('acceptEdits');
    expect(resolvePermissionMode('plan')).toBe('plan');
  });

  it('lets the environment override the project setting', () => {
    process.env[PERMISSION_MODE_ENV] = 'acceptEdits';
    expect(resolvePermissionMode('bypassPermissions')).toBe('acceptEdits');
  });

  it('ignores an unrecognised override rather than wedging every run', () => {
    process.env[PERMISSION_MODE_ENV] = 'yolo';
    expect(resolvePermissionMode('plan')).toBe('plan');
    expect(resolvePermissionMode(undefined)).toBe('bypassPermissions');
  });

  it('ignores a stored mode it does not recognise', () => {
    expect(resolvePermissionMode('somethingElse')).toBe('bypassPermissions');
  });
});

describe('claudePermissionArgs', () => {
  it('uses the CLI flag that skips checks outright for the default mode', () => {
    expect(claudePermissionArgs('bypassPermissions')).toEqual(['--dangerously-skip-permissions']);
  });

  it('passes a restrictive mode through as --permission-mode', () => {
    expect(claudePermissionArgs('acceptEdits')).toEqual(['--permission-mode', 'acceptEdits']);
    expect(claudePermissionArgs('plan')).toEqual(['--permission-mode', 'plan']);
    expect(claudePermissionArgs('default')).toEqual(['--permission-mode', 'default']);
  });

  it('never forwards a value the CLI would reject', () => {
    // `dontAsk` is storable but is not a Claude Code mode; forwarding it would
    // make the CLI exit before doing any work.
    expect(claudePermissionArgs('dontAsk')).toEqual(['--dangerously-skip-permissions']);
    expect(claudePermissionArgs('')).toEqual(['--dangerously-skip-permissions']);
  });
});

describe('permissionModeAllowsCommands', () => {
  it('is true only where the agent can really run a command', () => {
    expect(permissionModeAllowsCommands('bypassPermissions')).toBe(true);
    expect(permissionModeAllowsCommands('acceptEdits')).toBe(false);
    expect(permissionModeAllowsCommands('plan')).toBe(false);
  });
});
