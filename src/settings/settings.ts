import { invoke } from "@tauri-apps/api/core";
import type { Binding, ViewMode } from "../viewer/spreads";
import { toError } from "./backend-error";

/**
 * App-wide settings (issue #9).
 *
 * These belong to the app rather than to one PDF — the binding and view mode a
 * document opens with, and which translation provider to ask — and live in a
 * JSON file in the OS config directory, written by the Rust side.
 *
 * API keys are not here: they go to the OS keychain and never cross into the
 * WebView. See `api-keys.ts`, which can only ask whether one is configured.
 */

export const SETTINGS_VERSION = 1;

export type TranslationProviderId = "claude" | "openai" | "deepl";

export interface TranslationSettings {
  provider: TranslationProviderId;
  /** BCP-47 tag translations are asked for, e.g. `ja`. */
  targetLanguage: string;
}

export interface Settings {
  version: number;
  /** Binding a document opens with; still switchable inside the viewer. */
  defaultBinding: Binding;
  defaultViewMode: ViewMode;
  translation: TranslationSettings;
}

export interface TranslationProviderInfo {
  id: TranslationProviderId;
  label: string;
  /** Where the reader gets a key, shown next to the input. */
  keyHint: string;
}

export const TRANSLATION_PROVIDERS: readonly TranslationProviderInfo[] = [
  {
    id: "claude",
    label: "Claude",
    keyHint: "console.anthropic.com で発行したキー",
  },
  {
    id: "openai",
    label: "OpenAI",
    keyHint: "platform.openai.com で発行したキー",
  },
  {
    id: "deepl",
    label: "DeepL",
    keyHint: "DeepL API の認証キー",
  },
];

export interface TargetLanguage {
  tag: string;
  label: string;
}

/** The languages the picker offers; the backend accepts any BCP-47 tag. */
export const TARGET_LANGUAGES: readonly TargetLanguage[] = [
  { tag: "ja", label: "日本語" },
  { tag: "en", label: "English" },
  { tag: "zh", label: "中文" },
  { tag: "ko", label: "한국어" },
  { tag: "de", label: "Deutsch" },
  { tag: "fr", label: "Français" },
];

export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    defaultBinding: "left",
    defaultViewMode: "single",
    translation: { provider: "claude", targetLanguage: "ja" },
  };
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Field-by-field normalization of whatever the backend hands over.
 *
 * The backend normalizes too, but it is not the only writer `settings.json`
 * can have, and a build that adds a value this one has never heard of should
 * cost the reader one setting rather than the whole screen.
 */
export function normalizeSettings(value: unknown): Settings {
  const defaults = defaultSettings();
  const translation = field(value, "translation");
  const targetLanguage = field(translation, "targetLanguage");

  return {
    version: SETTINGS_VERSION,
    defaultBinding: oneOf(
      field(value, "defaultBinding"),
      ["left", "right"] as const,
      defaults.defaultBinding,
    ),
    defaultViewMode: oneOf(
      field(value, "defaultViewMode"),
      ["single", "spread"] as const,
      defaults.defaultViewMode,
    ),
    translation: {
      provider: oneOf(
        field(translation, "provider"),
        TRANSLATION_PROVIDERS.map((provider) => provider.id),
        defaults.translation.provider,
      ),
      targetLanguage:
        typeof targetLanguage === "string" && targetLanguage.trim() !== ""
          ? targetLanguage.trim()
          : defaults.translation.targetLanguage,
    },
  };
}

async function invokeSettings(
  command: string,
  args?: Record<string, unknown>,
): Promise<Settings> {
  try {
    return normalizeSettings(await invoke(command, args));
  } catch (error) {
    throw toError(error);
  }
}

export function loadSettings(): Promise<Settings> {
  return invokeSettings("load_settings");
}

/** Resolves to the settings as stored, which may differ from what was sent. */
export function saveSettings(settings: Settings): Promise<Settings> {
  return invokeSettings("save_settings", { settings });
}
