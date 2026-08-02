import { describe, expect, it } from "vitest";
import { formatTranslationNote, languageLabel } from "./format";

describe("formatTranslationNote", () => {
  it("keeps the original above the translation, with its page", () => {
    expect(
      formatTranslationNote({
        original: "Attention is all you need.",
        translated: "必要なのは注意だけ。",
        page: 3,
        targetLanguage: "ja",
      }),
    ).toBe(
      "> Attention is all you need.\n>\n> — p.3\n\n**訳（日本語）**\n\n必要なのは注意だけ。",
    );
  });

  it("quotes every line of a selection that spans several", () => {
    const note = formatTranslationNote({
      original: "first line\n\nsecond line",
      translated: "1行目\n\n2行目",
      page: 12,
      targetLanguage: "ja",
    });

    expect(note).toContain("> first line\n>\n> second line");
    // The translation is prose, not a quote: it stays as it came back.
    expect(note.endsWith("1行目\n\n2行目")).toBe(true);
  });

  it("drops whitespace a provider padded the translation with", () => {
    const note = formatTranslationNote({
      original: "text",
      translated: "  訳文  \n",
      page: 1,
      targetLanguage: "ja",
    });

    expect(note.endsWith("訳文")).toBe(true);
  });
});

describe("languageLabel", () => {
  it("names the languages the picker offers", () => {
    expect(languageLabel("ja")).toBe("日本語");
    expect(languageLabel("en")).toBe("English");
  });

  it("falls back to the tag itself for one it does not list", () => {
    // The backend takes any BCP-47 tag, so a hand-edited settings file can
    // name a language this build has no wording for.
    expect(languageLabel("sv-SE")).toBe("sv-SE");
  });
});
