import fs from 'node:fs';
import path from 'node:path';

/**
 * Executable resolution and argument quoting.
 *
 * Windows makes this non-trivial in a way that matters here:
 *  - npm installs a CLI as `name.cmd`, not `name.exe`, and Node refuses to
 *    spawn a `.cmd` without a shell (the CVE-2024-27980 fix), so
 *    `spawn('claude', args)` fails with EINVAL or ENOENT.
 *  - Passing a command line through `cmd.exe` needs verbatim arguments and
 *    correct quoting, or arguments are silently mangled.
 *
 * So: prefer a directly spawnable executable and use no shell at all. Fall
 * back to `cmd.exe` with a tested quoter only when the only thing on PATH is a
 * shim. Untrusted text (an implementation prompt) is never passed as an
 * argument on either path — it goes over stdin.
 */

export interface ResolvedExecutable {
  /** What to hand to `spawn` as the file. */
  file: string;
  /** Prefix arguments, e.g. cmd.exe switches. */
  prefixArgs: string[];
  /** True when the caller must pre-quote and set windowsVerbatimArguments. */
  viaCmd: boolean;
  /** The executable that was found, for diagnostics. */
  resolvedPath: string | null;
}

/** Extensions Node can spawn directly, in preference order. */
const DIRECT_EXTENSIONS = ['.exe', '.com'];
/** Extensions that require cmd.exe. */
const SHIM_EXTENSIONS = ['.cmd', '.bat'];

function pathDirectories(): string[] {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((d) => d.trim())
    .filter(Boolean);
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Finds an executable on PATH, preferring one Node can spawn without a shell.
 * A name that already contains a separator is treated as a path.
 */
export function resolveExecutable(name: string): ResolvedExecutable {
  const looksLikePath = name.includes('/') || name.includes('\\');

  if (process.platform !== 'win32') {
    // POSIX: spawn by name and let execvp resolve it, as usual.
    return { file: name, prefixArgs: [], viaCmd: false, resolvedPath: looksLikePath ? name : null };
  }

  const comspec = process.env.ComSpec ?? 'cmd.exe';

  if (looksLikePath) {
    const ext = path.extname(name).toLowerCase();
    if (SHIM_EXTENSIONS.includes(ext)) {
      return { file: comspec, prefixArgs: ['/d', '/s', '/c'], viaCmd: true, resolvedPath: name };
    }
    if (ext === '') {
      // An extensionless path on Windows: try the known extensions beside it.
      for (const candidate of [...DIRECT_EXTENSIONS, ...SHIM_EXTENSIONS]) {
        const withExt = `${name}${candidate}`;
        if (!isFile(withExt)) continue;
        return SHIM_EXTENSIONS.includes(candidate)
          ? { file: comspec, prefixArgs: ['/d', '/s', '/c'], viaCmd: true, resolvedPath: withExt }
          : { file: withExt, prefixArgs: [], viaCmd: false, resolvedPath: withExt };
      }
    }
    return { file: name, prefixArgs: [], viaCmd: false, resolvedPath: name };
  }

  const directories = pathDirectories();

  // A directly spawnable executable is strictly preferable: no shell involved.
  for (const extension of DIRECT_EXTENSIONS) {
    for (const directory of directories) {
      // turbopackIgnore: this walks the runtime PATH, not project files.
      const candidate = path.join(/* turbopackIgnore: true */ directory, `${name}${extension}`);
      if (isFile(candidate)) {
        return { file: candidate, prefixArgs: [], viaCmd: false, resolvedPath: candidate };
      }
    }
  }

  // An npm-style shim. Some ship the real executable in a sibling package
  // directory, which is worth preferring over going through cmd.exe.
  for (const extension of SHIM_EXTENSIONS) {
    for (const directory of directories) {
      // turbopackIgnore: this walks the runtime PATH, not project files.
      const candidate = path.join(/* turbopackIgnore: true */ directory, `${name}${extension}`);
      if (!isFile(candidate)) continue;

      const sibling = findShimTarget(candidate, name);
      if (sibling) {
        return { file: sibling, prefixArgs: [], viaCmd: false, resolvedPath: sibling };
      }
      return { file: comspec, prefixArgs: ['/d', '/s', '/c'], viaCmd: true, resolvedPath: candidate };
    }
  }

  // Not found. Return the bare name so the spawn failure names it plainly.
  return { file: name, prefixArgs: [], viaCmd: false, resolvedPath: null };
}

/**
 * Reads an npm `.cmd` shim to find the real executable it launches.
 *
 * The generated shim contains a line like
 *   "%dp0%\node_modules\pkg\bin\tool.exe"   %*
 * Resolving it lets the spawn skip cmd.exe entirely. Returns null whenever the
 * shim does not match that shape, which is not an error: the cmd.exe path
 * still works.
 */
function findShimTarget(shimPath: string, name: string): string | null {
  let contents: string;
  try {
    contents = fs.readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }

  const shimDir = path.dirname(shimPath);
  const pattern = /"%dp0%[\\/]([^"]+\.exe)"/i;
  const match = pattern.exec(contents);
  if (match?.[1]) {
    const candidate = path.resolve(shimDir, match[1]);
    if (isFile(candidate)) return candidate;
  }

  // Fall back to the conventional npm layout for a packaged binary.
  const conventional = path.join(shimDir, 'node_modules', name, 'bin', `${name}.exe`);
  if (isFile(conventional)) return conventional;

  return null;
}

/**
 * Quotes one argument for a Windows command line, per the rules
 * CommandLineToArgvW applies.
 *
 * Trailing backslashes before the closing quote must be doubled, or they
 * escape that quote and swallow the next argument.
 */
export function quoteWindowsArg(arg: string): string {
  if (arg.length === 0) return '""';
  // Nothing to do when the argument holds no separator or quote.
  if (!/[\s"]/.test(arg)) return arg;

  let quoted = '"';
  let backslashes = 0;

  for (const char of arg) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      // Double the run of backslashes, then escape the quote itself.
      quoted += '\\'.repeat(backslashes * 2 + 1);
      quoted += '"';
      backslashes = 0;
      continue;
    }
    quoted += '\\'.repeat(backslashes);
    backslashes = 0;
    quoted += char;
  }

  quoted += '\\'.repeat(backslashes * 2);
  quoted += '"';
  return quoted;
}

export interface SpawnPlan {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
  /** For diagnostics and log artifacts. */
  describe: string;
}

/**
 * Builds a spawn plan for an executable plus a structured argument list.
 *
 * When cmd.exe is required, the whole command line is quoted as one verbatim
 * argument, which is the same shape Node's own `shell: true` produces.
 */
export function planSpawn(name: string, args: readonly string[]): SpawnPlan {
  const resolved = resolveExecutable(name);

  if (!resolved.viaCmd) {
    return {
      file: resolved.file,
      args: [...args],
      windowsVerbatimArguments: false,
      describe: `${resolved.file} ${args.join(' ')}`,
    };
  }

  const commandLine = [resolved.resolvedPath ?? name, ...args].map(quoteWindowsArg).join(' ');
  return {
    file: resolved.file,
    // cmd /s strips the outermost pair of quotes and runs what is between them.
    args: [...resolved.prefixArgs, `"${commandLine}"`],
    windowsVerbatimArguments: true,
    describe: commandLine,
  };
}
