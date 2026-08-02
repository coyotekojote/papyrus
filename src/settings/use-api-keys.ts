import { useCallback, useEffect, useRef, useState } from "react";
import { apiKeyStatus, deleteApiKey, saveApiKey } from "./api-keys";
import { describeError } from "../backend-error";
import type { TranslationProviderId } from "./settings";

/**
 * Which providers have an API key, and the two things that can be done about
 * it (issue #9). The keys themselves stay in the OS keychain — nothing here
 * ever holds one beyond the moment it is handed to the backend.
 *
 * Every change is followed by a fresh status read rather than an assumption:
 * the keychain can refuse a write the reader has to know about, and a row that
 * says "設定済み" when the key never landed is worse than a slow one.
 */

export type ApiKeysConfigured = Partial<Record<TranslationProviderId, boolean>>;

export interface UseApiKeysResult {
  /** null until the first status read succeeds. */
  configured: ApiKeysConfigured | null;
  error: string | null;
  /** The provider whose key is being written or removed, if any. */
  busy: TranslationProviderId | null;
  /** Resolves to whether the key was stored, so the caller can clear its input. */
  save(provider: TranslationProviderId, key: string): Promise<boolean>;
  remove(provider: TranslationProviderId): Promise<boolean>;
}

export function useApiKeys(): UseApiKeysResult {
  const [configured, setConfigured] = useState<ApiKeysConfigured | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<TranslationProviderId | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const status = await apiKeyStatus();
    if (!mountedRef.current) return;
    setConfigured(
      Object.fromEntries(
        status.map((entry) => [entry.provider, entry.configured]),
      ) as ApiKeysConfigured,
    );
  }, []);

  useEffect(() => {
    void refresh().catch((cause: unknown) => {
      if (mountedRef.current) setError(describeError(cause));
    });
  }, [refresh]);

  const run = useCallback(
    async (provider: TranslationProviderId, action: () => Promise<void>) => {
      setBusy(provider);
      setError(null);
      let stored = true;
      try {
        await action();
      } catch (cause) {
        stored = false;
        if (mountedRef.current) setError(describeError(cause));
      }
      try {
        // Re-read either way: a write that failed can still have gone through
        // far enough to change what is there.
        await refresh();
      } catch (cause) {
        // A write that succeeded is not reported as a failure just because the
        // status could not be read back afterwards.
        if (mountedRef.current && stored) setError(describeError(cause));
      }
      if (mountedRef.current) setBusy(null);
      return stored;
    },
    [refresh],
  );

  return {
    configured,
    error,
    busy,
    save: useCallback(
      (provider: TranslationProviderId, key: string) =>
        run(provider, () => saveApiKey(provider, key)),
      [run],
    ),
    remove: useCallback(
      (provider: TranslationProviderId) =>
        run(provider, () => deleteApiKey(provider)),
      [run],
    ),
  };
}
