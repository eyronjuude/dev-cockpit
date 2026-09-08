import { describe, expect, it } from 'vitest';

import { planSpawn, quoteWindowsArg, resolveExecutable } from '@/process/exec';

describe('quoteWindowsArg', () => {
  it('leaves a simple argument alone', () => {
    expect(quoteWindowsArg('--verbose')).toBe('--verbose');
    expect(quoteWindowsArg('claude-opus-5')).toBe('claude-opus-5');
  });

  it('quotes an argument containing a space', () => {
    expect(quoteWindowsArg('C:\\Program Files\\tool')).toBe('"C:\\Program Files\\tool"');
  });

  it('represents an empty argument as an empty quoted string', () => {
    // The reviewer relies on this: `--tools ""` is what removes every tool.
    expect(quoteWindowsArg('')).toBe('""');
  });

  it('escapes an embedded double quote', () => {
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('doubles trailing backslashes so they cannot escape the closing quote', () => {
    // Without doubling, the closing quote is escaped and the next argument is
    // swallowed into this one.
    expect(quoteWindowsArg('C:\\path with space\\')).toBe('"C:\\path with space\\\\"');
  });

  it('doubles the backslash run that precedes an embedded quote', () => {
    expect(quoteWindowsArg('a\\"b')).toBe('"a\\\\\\"b"');
  });

  it('round-trips through the documented parsing rules', () => {
    // Re-implements CommandLineToArgvW's rules for a single quoted argument,
    // to check the quoter against the spec rather than against itself.
    const parseSingle = (quoted: string): string => {
      let out = '';
      let i = 0;
      let inQuotes = false;
      while (i < quoted.length) {
        const char = quoted[i]!;
        if (char === '\\') {
          let slashes = 0;
          while (quoted[i] === '\\') {
            slashes += 1;
            i += 1;
          }
          if (quoted[i] === '"') {
            out += '\\'.repeat(Math.floor(slashes / 2));
            if (slashes % 2 === 1) {
              out += '"';
              i += 1;
            } else {
              inQuotes = !inQuotes;
              i += 1;
            }
          } else {
            out += '\\'.repeat(slashes);
          }
          continue;
        }
        if (char === '"') {
          inQuotes = !inQuotes;
          i += 1;
          continue;
        }
        out += char;
        i += 1;
      }
      return out;
    };

    for (const original of [
      'plain',
      'with space',
      'trailing\\',
      'trailing\\\\',
      'quote"inside',
      'a\\"b',
      'C:\\Users\\Some One\\AppData\\',
      '',
    ]) {
      expect(parseSingle(quoteWindowsArg(original)), `round trip of ${JSON.stringify(original)}`).toBe(
        original,
      );
    }
  });
});

describe('resolveExecutable', () => {
  it('finds node, which exists on every machine that can run this test', () => {
    const resolved = resolveExecutable('node');
    if (process.platform === 'win32') {
      // node ships as node.exe, so it must resolve without needing cmd.exe.
      expect(resolved.viaCmd).toBe(false);
      expect(resolved.resolvedPath?.toLowerCase()).toContain('node.exe');
    } else {
      expect(resolved.file).toBe('node');
    }
  });

  it('returns the bare name when nothing is found, so the error names it', () => {
    const resolved = resolveExecutable('definitely-not-installed-zzz');
    expect(resolved.resolvedPath).toBeNull();
    expect(resolved.file).toBe('definitely-not-installed-zzz');
  });

  it('treats a value containing a separator as a path', () => {
    const resolved = resolveExecutable('./local/tool');
    expect(resolved.resolvedPath).toBe('./local/tool');
  });
});

describe('planSpawn', () => {
  it('passes arguments through untouched when no shell is involved', () => {
    const plan = planSpawn('node', ['-e', 'console.log(1)']);
    if (!plan.windowsVerbatimArguments) {
      expect(plan.args).toEqual(['-e', 'console.log(1)']);
    }
  });

  it('produces a runnable plan for node that actually executes', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const plan = planSpawn('node', ['-e', 'console.log("planned ok")']);
    const { stdout } = await execFileAsync(plan.file, plan.args, {
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      windowsHide: true,
    });
    expect(stdout).toContain('planned ok');
  });

  it('survives an argument containing spaces and quotes end to end', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    // A path-shaped argument with a space is the realistic case: --add-dir.
    const tricky = 'a value with "quotes" and spaces';
    const plan = planSpawn('node', [
      '-e',
      'process.stdout.write(process.argv[1] ?? "MISSING")',
      tricky,
    ]);
    const { stdout } = await execFileAsync(plan.file, plan.args, {
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      windowsHide: true,
    });
    expect(stdout).toBe(tricky);
  });
});
