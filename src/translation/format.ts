import { TARGET_LANGUAGES } from "../settings/settings";
import { formatQuote } from "../viewer/highlights";

/**
 * A translation as it goes into notes.md (issue #10).
 *
 * The original is kept above the translation: a note that has only the
 * translation is impossible to check later, and the quote is also what makes
 * the entry findable by searching the paper's own words.
 */

export interface TranslationNote {
  original: string;
  translated: string;
  page: number;
  /** BCP-47 tag the translation was asked for. */
  targetLanguage: string;
}

/** The picker's name for a tag, or the tag itself for one it does not list. */
export function languageLabel(tag: string): string {
  return (
    TARGET_LANGUAGES.find((language) => language.tag === tag)?.label ?? tag
  );
}

export function formatTranslationNote(note: TranslationNote): string {
  const quote = formatQuote(note.original, note.page);
  return `${quote}\n\n**訳（${languageLabel(note.targetLanguage)}）**\n\n${note.translated.trim()}`;
}
