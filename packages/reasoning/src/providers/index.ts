/**
 * @dino/reasoning — Provider registry
 *
 * Register and look up providers by id. Used by the LLM router.
 */

import type { ReasoningProvider } from '../types';

export interface ProviderRegistry {
  /** Register a provider. Throws if id already registered. */
  register(provider: ReasoningProvider): void;
  /** Get a provider by id. Returns undefined if not found. */
  get(id: string): ReasoningProvider | undefined;
  /** List all registered provider ids. */
  ids(): string[];
}

export function createProviderRegistry(): ProviderRegistry {
  const providers = new Map<string, ReasoningProvider>();

  return {
    register(provider: ReasoningProvider): void {
      if (providers.has(provider.id)) {
        throw new Error(`Provider "${provider.id}" is already registered`);
      }
      providers.set(provider.id, provider);
    },

    get(id: string): ReasoningProvider | undefined {
      return providers.get(id);
    },

    ids(): string[] {
      return [...providers.keys()];
    },
  };
}
