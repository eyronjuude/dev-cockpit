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
 */

const REDACTED = '[redacted]';

/** Ordered: more specific patterns first so they win the replacement. */
const PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // Anthropic
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  // OpenAI (project and legacy)
  { name: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  // GitHub
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g },
  { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  // Cloud providers
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  // Generic bearer / JWT
  { name: 'bearer', re: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // PEM blocks
  {
    name: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  // Connection strings with inline credentials
  { name: 'url-credentials', re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s/@]+@/gi },
  // KEY=value / "key": "value" for names that look secret
  {
    name: 'named-secret',
    re: /\b([A-Za-z0-9_.-]*(?:PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET|CREDENTIAL)[A-Za-z0-9_.-]*)(\s*[:=]\s*)("?)([^\s"',;]{4,})\3/gi,
  },
];

export interface RedactionResult {
  text: string;
  /** Pattern names that fired, for surfacing "output was redacted" in the UI. */
  hits: string[];
}

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

export function redact(input: string): RedactionResult {
  if (!input) return { text: input, hits: [] };
  let text = input;
  const hits = new Set<string>();

  for (const { name, re } of PATTERNS) {
    // Fresh lastIndex each pass; the regexes are global.
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    hits.add(name);
    re.lastIndex = 0;
    text = text.replace(re, (match, ...groups) => {
      if (name === 'url-credentials') return `${groups[0]}${REDACTED}:${REDACTED}@`;
      if (name === 'named-secret') {
        const [key, sep, quote] = groups as [string, string, string];
        return `${key}${sep}${quote}${REDACTED}${quote}`;
      }
      if (name === 'bearer') {
        const scheme = match.split(/\s+/)[0] ?? 'Bearer';
        return `${scheme} ${REDACTED}`;
      }
      return REDACTED;
    });
  }

  envSecretsCache ??= environmentSecrets();
  for (const secret of envSecretsCache) {
    if (!text.includes(secret)) continue;
    hits.add('environment-value');
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
