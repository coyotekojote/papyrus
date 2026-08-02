import { invoke } from "@tauri-apps/api/core";
import { toError } from "../backend-error";
import type { TranslationProviderId } from "../settings/settings";

/**
 * Translating a selection (issue #10).
 *
 * The request itself is made in Rust: the API key never crosses into the
 * WebView (see `settings/api-keys.ts`), and the providers grant no CORS for a
 * call from a page anyway. Which provider, which model and which target
 * language are read from the settings on that side too, so nothing here has to
 * be kept in step with the settings screen.
 */

export interface TranslationInput {
  /** The selected text; blank selections are refused by the backend. */
  text: string;
  /** Text before the selection on the page, passed only as context. */
  contextBefore: string;
  contextAfter: string;
}

export interface Translation {
  text: string;
  provider: TranslationProviderId;
  /** The model that answered, or null when the provider chose its own. */
  model: string | null;
  targetLanguage: string;
}

export async function translate(
  request: TranslationInput,
): Promise<Translation> {
  try {
    return await invoke<Translation>("translate", { request });
  } catch (error) {
    throw toError(error);
  }
}
