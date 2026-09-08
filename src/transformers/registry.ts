import 'server-only';

import type { TransformerProvider } from './types';
import {
  AnthropicApiTransformer,
  ClaudeCliTransformer,
  CodexCliTransformer,
  NoopTransformer,
  OpenAiTransformer,
} from './providers';

/**
 * Transformer registry.
 *
 * Adding a provider means one entry here plus a class implementing
 * `TransformerProvider`. Nothing else in the app needs to know it exists —
 * see docs/EXTENDING.md.
 */
const PROVIDERS: TransformerProvider[] = [
  new NoopTransformer(),
  new CodexCliTransformer(),
  new ClaudeCliTransformer(),
  new OpenAiTransformer(),
  new AnthropicApiTransformer(),
];

export const DEFAULT_TRANSFORMER_ID = 'none';

export function listTransformers(): readonly TransformerProvider[] {
  return PROVIDERS;
}

export function getTransformer(id: string | null | undefined): TransformerProvider {
  if (!id) return PROVIDERS[0] as TransformerProvider;
  return PROVIDERS.find((p) => p.id === id) ?? (PROVIDERS[0] as TransformerProvider);
}

export interface TransformerStatus {
  id: string;
  label: string;
  requirement: string;
  available: boolean;
  detail: string;
}

export async function transformerStatuses(): Promise<TransformerStatus[]> {
  return Promise.all(
    PROVIDERS.map(async (provider) => {
      try {
        const availability = await provider.checkAvailability();
        return {
          id: provider.id,
          label: provider.label,
          requirement: provider.requirement,
          available: availability.available,
          detail: availability.detail,
        };
      } catch (err) {
        return {
          id: provider.id,
          label: provider.label,
          requirement: provider.requirement,
          available: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}
