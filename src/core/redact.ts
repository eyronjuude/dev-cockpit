/**
 * Secret redaction for anything the app stores or displays from a child
 * process: agent text, stdout, stderr, log artifacts.
 *
 * Deliberately NOT applied to factual artifacts (git diffs, exit codes, file
 * paths, test output structure) beyond the same pattern pass — the rule is that
 * redaction may remove a secret's value but must never restructure evidence.
 *
 * This is defence in depth, not a guarantee. A project that prints a novel
 * credential format will leak it. See docs/LIMITATIONS in the README.
 *
 * The patterns live in `redact-patterns.ts` so the browser can run them too;
 * this module adds the pass that only makes sense on the server.
 */

import { redactPatterns, REDACTED, type RedactionResult } from './redact-patterns';

export type { RedactionResult };
export { redactPatterns } from './redact-patterns';

/**
 * Values from the current environment that are worth masking on sight, so a
 * project's own credentials do not land in the run log even in an unusual
 * format. Only long-ish values of secret-looking names are used.
 */
function environmentSecrets(): string[] {
  const secretName = /(PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET|CREDENTIAL)/i;
  const out: string[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 12) continue;
    if (!secretName.test(name)) continue;
    out.push(value);
  }
  // Longest first: masking a superstring before its substring avoids partial leaks.
  return out.sort((a, b) => b.length - a.length);
}

let envSecretsCache: string[] | null = null;

/**
 * Secrets supplied by configuration rather than the environment.
 *
 * A validation step or a preview can carry its own `KEY=VALUE` pairs. Those
 * never reach `process.env`, so the scan above cannot see them — which would
 * make the one field a user is most likely to put a credential in the one
 * field that is not masked. Registering them closes that gap.
 *
 * Additive and process-wide on purpose: output arrives asynchronously, often
 * after the step that produced it has moved on, so scoping the mask to a step
 * would drop the value exactly when it is still in flight.
 */
const extraSecrets = new Set<string>();

export function registerExtraSecrets(values: readonly string[]): void {
  for (const value of values) {
    // Too short to be a credential, and masking it would shred ordinary output.
    if (value.length < 4) continue;
    extraSecrets.add(value);
  }
}

/** Test seam: forget configuration-supplied secrets. */
export function clearExtraSecrets(): void {
  extraSecrets.clear();
}

export function redact(input: string): RedactionResult {
  if (!input) return { text: input, hits: [] };

  const pass = redactPatterns(input);
  let text = pass.text;
  const hits = new Set(pass.hits);

  envSecretsCache ??= environmentSecrets();
  for (const secret of envSecretsCache) {
    if (!text.includes(secret)) continue;
    hits.add('environment-value');
    text = text.split(secret).join(REDACTED);
  }

  // Longest first, so masking a superstring before its substring cannot leave
  // a partial value behind.
  for (const secret of [...extraSecrets].sort((a, b) => b.length - a.length)) {
    if (!text.includes(secret)) continue;
    hits.add('configured-value');
    text = text.split(secret).join(REDACTED);
  }

  return { text, hits: [...hits] };
}

/** Convenience for call sites that do not need the hit list. */
export const redactText = (input: string): string => redact(input).text;

/** Test seam: forget the cached environment scan. */
export function resetEnvironmentSecretCache(): void {
  envSecretsCache = null;
}
