import type { CloudAiProvider } from "@bb/plugin-sdk";

// Host-side slot for the experimental cloud AI provider seam
// (`experimental_registerCloudAiProvider`). Module-scoped like the lazy pi-ai
// registry in inference.ts: the AI chokepoints run deep in the thread
// lifecycle with slim deps, so a singleton beats threading a registry through
// every call site. Single slot — bb has one cloud relationship; the most
// recent registration wins (a plugin reload re-registers over itself).

interface RegisteredCloudAiProvider {
  pluginId: string;
  provider: CloudAiProvider;
}

let registered: RegisteredCloudAiProvider | null = null;

/** Returns an unregister hook (bound to this exact registration, so a stale
 * dispose cannot tear down a newer registration). */
export function registerCloudAiProvider(
  pluginId: string,
  provider: CloudAiProvider,
): () => void {
  const registration: RegisteredCloudAiProvider = { pluginId, provider };
  registered = registration;
  return () => {
    if (registered === registration) registered = null;
  };
}

/** The registered provider when it reports itself available, else null. */
export function getAvailableCloudAiProvider(): CloudAiProvider | null {
  if (registered === null) return null;
  return registered.provider.isAvailable() ? registered.provider : null;
}

export function resetCloudAiProviderForTests(): void {
  registered = null;
}
