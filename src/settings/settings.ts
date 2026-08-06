import { invoke } from "@tauri-apps/api/core";
import type { Binding, ViewMode } from "../viewer/spreads";
import { toError, type SettingsOperation } from "../backend-error";

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
  /**
   * Model id per provider. Kept per provider rather than as one field so
   * switching provider and back does not lose the choice; a provider with no
   * entry uses whatever default the translation layer (issue #10) picks.
   */
  models: Partial<Record<TranslationProviderId, string>>;
}

export interface Settings {
  version: number;
  /** Binding a document opens with; still switchable inside the viewer. */
  defaultBinding: Binding;
  defaultViewMode: ViewMode;
  translation: TranslationSettings;
  /** Insert the PDF's outline as markdown headings into an empty note (#46). */
  notesOutlineInsert: boolean;
  /**
   * Move the notes cursor to the heading of the section on screen (#46).
   * Matching is by exact title string against the PDF's own outline, which
   * misleads more than it helps once that outline is coarse or the note's
   * headings have since been edited — off by default (issue #74), opt-in
   * once the reader has confirmed the outline actually lines up.
   */
  notesOutlineFollow: boolean;
}

export interface ModelSuggestion {
  id: string;
  label: string;
}

export interface TranslationProviderInfo {
  id: TranslationProviderId;
  label: string;
  /** Where the reader gets a key, shown next to the input. */
  keyHint: string;
  /**
   * Models offered as a shortcut. Any id is still accepted — providers ship
   * models faster than this app does — so the list is a convenience, not a
   * limit. Empty for a provider whose model ids this build cannot state with
   * confidence: a wrong id would only fail later, at translation time.
   */
  models: readonly ModelSuggestion[];
  /**
   * False for a provider that translates with one engine and takes no model.
   * The field is shown but disabled, rather than hidden, so the reason is
   * visible where the reader looks for it.
   */
  selectableModel: boolean;
}

export const TRANSLATION_PROVIDERS: readonly TranslationProviderInfo[] = [
  {
    id: "claude",
    label: "Claude",
    keyHint: "console.anthropic.com で発行したキー",
    models: [
      { id: "claude-opus-5", label: "Claude Opus 5（最高品質）" },
      {
        id: "claude-sonnet-5",
        label: "Claude Sonnet 5（速度と品質のバランス）",
      },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5（高速・低コスト）" },
    ],
    selectableModel: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    keyHint: "platform.openai.com で発行したキー",
    models: [],
    selectableModel: true,
  },
  {
    id: "deepl",
    label: "DeepL",
    keyHint: "DeepL API の認証キー",
    models: [],
    selectableModel: false,
  },
];

export function providerInfo(
  id: TranslationProviderId,
): TranslationProviderInfo {
  const info = TRANSLATION_PROVIDERS.find((provider) => provider.id === id);
  if (!info) throw new Error(`unknown translation provider: ${id}`);
  return info;
}

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
    translation: { provider: "claude", targetLanguage: "ja", models: {} },
    notesOutlineInsert: true,
    // Off by default (issue #74): see `notesOutlineFollow`'s own doc comment.
    notesOutlineFollow: false,
  };
}

/** The model chosen for a provider, or null when it uses the provider's own. */
export function modelFor(
  settings: Settings,
  provider: TranslationProviderId,
): string | null {
  return settings.translation.models[provider] ?? null;
}

/**
 * Sets (or, with an empty id, clears) the model for one provider.
 *
 * Whitespace is dropped rather than kept: no model id contains any, the
 * backend refuses one that does, and a space accepted here would come back
 * from the save silently discarded.
 */
export function withModel(
  settings: Settings,
  provider: TranslationProviderId,
  model: string,
): Settings {
  const models = { ...settings.translation.models };
  const id = model.replace(/\s+/g, "");
  if (id === "") delete models[provider];
  else models[provider] = id;
  return { ...settings, translation: { ...settings.translation, models } };
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

function booleanField(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Keeps the entries naming a known provider with a usable model id. */
function normalizeModels(
  value: unknown,
): Partial<Record<TranslationProviderId, string>> {
  const models: Partial<Record<TranslationProviderId, string>> = {};
  for (const provider of TRANSLATION_PROVIDERS) {
    const model = field(value, provider.id);
    if (typeof model === "string" && model.trim() !== "") {
      models[provider.id] = model.trim();
    }
  }
  return models;
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
      models: normalizeModels(field(translation, "models")),
    },
    notesOutlineInsert: booleanField(
      field(value, "notesOutlineInsert"),
      defaults.notesOutlineInsert,
    ),
    notesOutlineFollow: booleanField(
      field(value, "notesOutlineFollow"),
      defaults.notesOutlineFollow,
    ),
  };
}

async function invokeSettings(
  command: string,
  operation: SettingsOperation,
  args?: Record<string, unknown>,
): Promise<Settings> {
  try {
    return normalizeSettings(await invoke(command, args));
  } catch (error) {
    // The operation is passed along so a failure says which half of the file
    // access went wrong: the same backend error covers both.
    throw toError(error, operation);
  }
}

export function loadSettings(): Promise<Settings> {
  return invokeSettings("load_settings", "load");
}

/** Resolves to the settings as stored, which may differ from what was sent. */
export function saveSettings(settings: Settings): Promise<Settings> {
  return invokeSettings("save_settings", "save", { settings });
}
