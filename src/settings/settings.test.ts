import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultSettings,
  loadSettings,
  modelFor,
  normalizeSettings,
  providerInfo,
  saveSettings,
  SETTINGS_VERSION,
  TRANSLATION_PROVIDERS,
  withModel,
  type Settings,
} from "./settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const stored: Settings = {
  version: SETTINGS_VERSION,
  defaultBinding: "right",
  defaultViewMode: "spread",
  translation: {
    provider: "deepl",
    targetLanguage: "en",
    models: { claude: "claude-opus-5" },
  },
  notesOutlineInsert: false,
  notesOutlineFollow: false,
};

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("normalizeSettings", () => {
  it("keeps every value the backend knows", () => {
    expect(normalizeSettings(stored)).toEqual(stored);
  });

  it("falls back to the defaults for anything that is not settings", () => {
    for (const value of [null, undefined, "settings", 42, []]) {
      expect(normalizeSettings(value)).toEqual(defaultSettings());
    }
  });

  it("replaces only the field it cannot read", () => {
    const settings = normalizeSettings({
      defaultBinding: "sideways",
      defaultViewMode: "spread",
      translation: { provider: "gemini", targetLanguage: "ko" },
    });

    expect(settings.defaultBinding).toBe("left");
    expect(settings.defaultViewMode).toBe("spread");
    expect(settings.translation.provider).toBe("claude");
    expect(settings.translation.targetLanguage).toBe("ko");
  });

  it("trims a language tag and rejects a blank one", () => {
    expect(
      normalizeSettings({ translation: { targetLanguage: "  fr  " } })
        .translation.targetLanguage,
    ).toBe("fr");
    expect(
      normalizeSettings({ translation: { targetLanguage: "   " } }).translation
        .targetLanguage,
    ).toBe("ja");
  });

  it("reports this build's version whatever the file said", () => {
    expect(normalizeSettings({ ...stored, version: 99 }).version).toBe(
      SETTINGS_VERSION,
    );
  });

  it("keeps a model per provider and drops what it cannot use", () => {
    const settings = normalizeSettings({
      translation: {
        models: {
          claude: "  claude-opus-5  ",
          openai: "   ",
          gemini: "gemini-pro",
          deepl: 5,
        },
      },
    });

    expect(settings.translation.models).toEqual({ claude: "claude-opus-5" });
  });

  it("has no model chosen by default", () => {
    expect(defaultSettings().translation.models).toEqual({});
    expect(normalizeSettings({ translation: {} }).translation.models).toEqual(
      {},
    );
  });

  it("defaults the outline settings to on", () => {
    expect(defaultSettings().notesOutlineInsert).toBe(true);
    expect(defaultSettings().notesOutlineFollow).toBe(true);
    expect(normalizeSettings({}).notesOutlineInsert).toBe(true);
    expect(normalizeSettings({}).notesOutlineFollow).toBe(true);
  });

  it("keeps an explicit false for either outline setting", () => {
    const settings = normalizeSettings({
      notesOutlineInsert: false,
      notesOutlineFollow: false,
    });
    expect(settings.notesOutlineInsert).toBe(false);
    expect(settings.notesOutlineFollow).toBe(false);
  });

  it("falls back to the default for a non-boolean outline setting", () => {
    for (const value of ["true", 0, null, undefined, {}]) {
      const settings = normalizeSettings({
        notesOutlineInsert: value,
        notesOutlineFollow: value,
      });
      expect(settings.notesOutlineInsert).toBe(true);
      expect(settings.notesOutlineFollow).toBe(true);
    }
  });
});

describe("model per provider", () => {
  it("reports the model chosen for a provider, or null", () => {
    expect(modelFor(stored, "claude")).toBe("claude-opus-5");
    expect(modelFor(stored, "openai")).toBeNull();
  });

  it("sets a model without touching the other providers", () => {
    const next = withModel(stored, "openai", "some-model");

    expect(next.translation.models).toEqual({
      claude: "claude-opus-5",
      openai: "some-model",
    });
    expect(stored.translation.models).toEqual({ claude: "claude-opus-5" });
  });

  it("clears the model when the field is emptied", () => {
    expect(withModel(stored, "claude", "").translation.models).toEqual({});
    expect(withModel(stored, "claude", "   ").translation.models).toEqual({});
  });

  it("drops whitespace rather than storing an id that would be refused", () => {
    // The backend rejects an id with inner whitespace, so accepting one here
    // would look saved and come back gone.
    expect(
      withModel(stored, "claude", " claude opus 5 ").translation.models.claude,
    ).toBe("claudeopus5");
  });

  it("names a real provider for every model suggestion it offers", () => {
    for (const provider of TRANSLATION_PROVIDERS) {
      expect(providerInfo(provider.id)).toBe(provider);
      // A suggestion is a shortcut for a real id, so it must at least look
      // like one — a label leaking into the value would be saved verbatim.
      for (const model of provider.models) {
        expect(model.id).toMatch(/^[\w.:-]+$/);
      }
    }
  });
});

describe("loadSettings", () => {
  it("normalizes what the backend returns", async () => {
    vi.mocked(invoke).mockResolvedValue({ ...stored, defaultBinding: "up" });

    await expect(loadSettings()).resolves.toEqual({
      ...stored,
      defaultBinding: "left",
    });
    expect(invoke).toHaveBeenCalledWith("load_settings", undefined);
  });

  it("says the settings could not be read, not written", async () => {
    vi.mocked(invoke).mockRejectedValue({
      kind: "io",
      message: "permission denied",
    });

    await expect(loadSettings()).rejects.toThrow(
      "設定を読み込めませんでした: permission denied",
    );
  });
});

describe("saveSettings", () => {
  it("says the settings could not be written, not read", async () => {
    vi.mocked(invoke).mockRejectedValue({ kind: "io", message: "disk full" });

    await expect(saveSettings(stored)).rejects.toThrow(
      "設定を保存できませんでした: disk full",
    );
  });

  it("sends the settings and resolves to what was actually stored", async () => {
    vi.mocked(invoke).mockResolvedValue({
      ...stored,
      translation: { ...stored.translation, targetLanguage: "en" },
    });

    const result = await saveSettings({
      ...stored,
      translation: { ...stored.translation, targetLanguage: "  en  " },
    });

    expect(invoke).toHaveBeenCalledWith("save_settings", {
      settings: {
        ...stored,
        translation: { ...stored.translation, targetLanguage: "  en  " },
      },
    });
    expect(result.translation.targetLanguage).toBe("en");
  });
});
