import { invoke } from "@tauri-apps/api/core";
import { toError } from "./backend-error";
import type { TranslationProviderId } from "./settings";

/**
 * API keys for the translation providers (issue #9).
 *
 * Keys live in the OS keychain and are handled entirely on the Rust side: this
 * module can write one, delete one, and ask whether one exists — there is no
 * command that reads a key back, on purpose. The translation calls (issue #10)
 * are made in Rust, where the key is already, so the WebView never needs it.
 */

export interface ApiKeyStatus {
  provider: TranslationProviderId;
  configured: boolean;
}

async function invokeKeychain<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toError(error);
  }
}

/** Which providers have a key stored. Never the keys themselves. */
export function apiKeyStatus(): Promise<ApiKeyStatus[]> {
  return invokeKeychain<ApiKeyStatus[]>("api_key_status");
}

/** Stores (or replaces) the key for one provider. Blank keys are refused. */
export function saveApiKey(
  provider: TranslationProviderId,
  key: string,
): Promise<void> {
  return invokeKeychain("save_api_key", { provider, key });
}

/** Removes the key. Deleting one that is not there is not an error. */
export function deleteApiKey(provider: TranslationProviderId): Promise<void> {
  return invokeKeychain("delete_api_key", { provider });
}
