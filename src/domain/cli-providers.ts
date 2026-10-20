/** Resolve saved selections from before the CLI-only provider transition. */
export function cliProviderId(id: string): string {
  if (id === 'openai-api') return 'codex-cli';
  if (id === 'anthropic-api') return 'claude-cli';
  return id;
}
