# 0006 — Resolve executables explicitly; keep untrusted text off command lines

**Status:** accepted

## Context

`spawn('claude', args)` fails on Windows. npm installs the CLI as `claude.cmd`,
there is no `claude.exe` on `PATH`, and Node refuses to spawn a `.cmd` without a
shell since the CVE-2024-27980 fix. Observed directly: `ENOENT` for `claude`,
`EINVAL` for `claude.cmd`.

Using `shell: true` would fix the spawn but put the implementation prompt —
arbitrary text, the largest injection surface in the system — on a command line.

## Decision

Two parts.

1. `process/exec.ts` resolves the executable. It prefers something directly
   spawnable (`.exe`, `.com`), reads an npm shim to find the real binary behind
   it, and only falls back to `cmd.exe` with verbatim arguments and a tested
   quoter when nothing else is available.
2. **The prompt is written to stdin.** It never appears as an argument on either
   path. Remaining arguments are structured values: a UUID, a model name, a mode
   name, configured paths.

Project-configured validation commands are the one place a shell is used
deliberately, via Node's own `shell: true` rather than a hand-rolled invocation.

## Why

An earlier version hand-rolled the `cmd.exe` invocation and silently mangled
every command — it exited 0 with empty output, which is the worst possible
failure mode. Node's own implementation gets the verbatim-argument rules right.

The quoter for the remaining path implements the documented
`CommandLineToArgvW` rules and is tested by round-tripping through a
reimplementation of those rules, including the trailing-backslash case that
otherwise escapes the closing quote and swallows the next argument.

## Consequences

- Extra platform-specific code, covered by 13 tests.
- Resolution walks `PATH` at runtime, which the bundler's static analysis reads
  as "trace the whole project". Annotated with `turbopackIgnore`.
- On the development machine the shim-reading step finds the real
  `claude.exe` behind `claude.cmd`, so runs spawn it directly with no shell at
  all. That is the best case, and it means the `cmd.exe` fallback is exercised
  only by the quoter's unit tests, not end to end. Worth knowing if a future
  change touches it.

## Postscript

The same class of bug bit the "open worktree" action later, from the opposite
direction: it used `shell: true` with an argument array, and Node's shell mode
joins arguments *without* quoting them. Every worktree path silently truncated
at its first space — and these paths routinely contain spaces. Routing that
launch through `planSpawn` fixed it. The lesson generalises: on Windows, either
own the quoting completely or avoid the shell completely. Half of each fails
quietly.
