import { registerExtraSecrets } from '@/core/redact';
import { secretValuesIn } from '@/domain/validation-steps';

/**
 * The environment a CLI implementation agent is spawned with.
 *
 * Dev Cockpit's own environment, then the project's `env` field over it, then
 * the two headless flags over both. The project layer is what lets an agent
 * run the same database check or integration call its validation steps run:
 * without it the agent saw whatever the Dev Cockpit server happened to have,
 * which is almost never the target project's configuration.
 *
 * The flags win over the project because a CLI that believes a human is
 * watching emits decorative output the stream parser was never written for.
 *
 * Secret-named values are registered for redaction before the process exists,
 * for the same reason the MCP config registers its own: output can start
 * arriving the moment the child spawns.
 */
export function agentProcessEnv(projectEnv: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const extra = projectEnv ?? {};
  registerExtraSecrets(secretValuesIn(extra));
  return {
    ...process.env,
    ...extra,
    CI: '1',
    FORCE_COLOR: '0',
  };
}
