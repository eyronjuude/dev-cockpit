import { AGENT_PERMISSION_MODES, DEFAULT_AGENT_PERMISSION_MODE } from '@/domain/types';

/**
 * Where a run's permission posture is decided, and the only place that turns it
 * into CLI flags.
 *
 * A Dev Cockpit run has nobody watching it. There is no terminal to answer an
 * approval in, so a permission check has exactly two possible outcomes: it is
 * bypassed, or the tool call is refused. "Ask" is not on the menu. That is why
 * the default is `bypassPermissions` and why `--permission-prompts none` is
 * still passed on top of it — anything that would somehow still prompt is
 * denied rather than left hanging.
 */

/** Values Claude Code's `--permission-mode` actually accepts. */
const CLAUDE_PERMISSION_MODES = new Set<string>([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
]);

const KNOWN_MODES = new Set<string>(AGENT_PERMISSION_MODES);

/** Env name for the machine-wide override. */
export const PERMISSION_MODE_ENV = 'DEV_COCKPIT_PERMISSION_MODE';

/**
 * The mode a run will actually use.
 *
 * `DEV_COCKPIT_PERMISSION_MODE` wins over the project setting, so a whole
 * machine can be tightened or loosened without editing every project. An
 * unrecognised value is ignored rather than obeyed: a typo there would
 * otherwise break every run on the box.
 */
export function resolvePermissionMode(configured?: string | null): string {
  const override = process.env[PERMISSION_MODE_ENV]?.trim();
  if (override && KNOWN_MODES.has(override)) return override;

  const stored = configured?.trim();
  if (stored && KNOWN_MODES.has(stored)) return stored;

  return DEFAULT_AGENT_PERMISSION_MODE;
}

/**
 * The permission flags for one Claude Code invocation.
 *
 * `bypassPermissions` is expressed as `--dangerously-skip-permissions` rather
 * than `--permission-mode bypassPermissions`. Both mean the same thing to the
 * CLI, but the dedicated flag is the one that has always meant it, so it is the
 * safer of the two to depend on across CLI versions.
 *
 * A mode the CLI does not know is not forwarded — it would exit on the
 * unrecognised value. It falls back to the default instead.
 */
export function claudePermissionArgs(mode: string): string[] {
  const effective: string = CLAUDE_PERMISSION_MODES.has(mode)
    ? mode
    : DEFAULT_AGENT_PERMISSION_MODE;

  return effective === 'bypassPermissions'
    ? ['--dangerously-skip-permissions']
    : ['--permission-mode', effective];
}
