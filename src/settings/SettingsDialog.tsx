import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useApiKeys } from "./use-api-keys";
import {
  TARGET_LANGUAGES,
  TRANSLATION_PROVIDERS,
  type Settings,
  type TranslationProviderId,
} from "./settings";

export interface SettingsDialogProps {
  settings: Settings;
  /** False while the settings are still being read; the form waits for them. */
  loaded: boolean;
  error: string | null;
  onChange: (change: (current: Settings) => Settings) => void;
  onClose: () => void;
}

/**
 * The settings screen (issue #9), as a modal over whatever the reader was
 * doing. General preferences go to `settings.json`; API keys go straight to
 * the OS keychain and are only ever reported here as configured or not.
 */
export function SettingsDialog({
  settings,
  loaded,
  error,
  onChange,
  onClose,
}: SettingsDialogProps) {
  const keys = useApiKeys();
  /** What has been typed per provider, cleared once the key is stored. */
  const [drafts, setDrafts] = useState<
    Partial<Record<TranslationProviderId, string>>
  >({});
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus moves into the dialog so Escape and the tab order belong to it —
  // and so the viewer's page-turn shortcuts are not what the keyboard hits.
  useEffect(() => dialogRef.current?.focus(), []);

  const setDraft = (provider: TranslationProviderId, value: string) =>
    setDrafts((current) => ({ ...current, [provider]: value }));

  const submitKey = (provider: TranslationProviderId) => {
    const key = drafts[provider] ?? "";
    if (key.trim() === "") return;
    void keys.save(provider, key).then((stored) => {
      // Kept on a failure so the reader can retry without pasting it again.
      if (stored) setDraft(provider, "");
    });
  };

  // Nothing behind the modal should react to the keyboard while it is open:
  // the viewer turns pages on arrow keys, which is exactly what typing an API
  // key into this dialog would otherwise do.
  const handleKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") onClose();
  };

  return (
    <div className="modal" onMouseDown={onClose}>
      <div
        className="modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-heading"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={handleKeyDown}
        // The backdrop closes on click; a click inside the panel is not one.
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__header">
          <h2 className="modal__title" id="settings-heading">
            設定
          </h2>
          <button
            type="button"
            className="modal__close"
            onClick={onClose}
            aria-label="設定を閉じる"
          >
            ×
          </button>
        </div>

        {error ? (
          <p className="modal__error" role="alert">
            {error}
          </p>
        ) : null}

        <section
          className="settings__section"
          aria-labelledby="settings-general"
        >
          <h3 className="settings__heading" id="settings-general">
            一般
          </h3>

          <label className="settings__row">
            <span className="settings__label">デフォルトの綴じ方向</span>
            <select
              className="settings__control"
              value={settings.defaultBinding}
              disabled={!loaded}
              onChange={(event) => {
                const defaultBinding =
                  event.target.value === "right" ? "right" : "left";
                onChange((current) => ({ ...current, defaultBinding }));
              }}
            >
              <option value="left">左綴じ</option>
              <option value="right">右綴じ</option>
            </select>
          </label>

          <label className="settings__row">
            <span className="settings__label">デフォルトの表示モード</span>
            <select
              className="settings__control"
              value={settings.defaultViewMode}
              disabled={!loaded}
              onChange={(event) => {
                const defaultViewMode =
                  event.target.value === "spread" ? "spread" : "single";
                onChange((current) => ({ ...current, defaultViewMode }));
              }}
            >
              <option value="single">単ページ</option>
              <option value="spread">見開き</option>
            </select>
          </label>

          <p className="settings__note">
            開いている文書にもすぐ反映されます。ツールバーでの切り替えは、その
            文書だけの一時的な変更です。
          </p>
        </section>

        <section
          className="settings__section"
          aria-labelledby="settings-translation"
        >
          <h3 className="settings__heading" id="settings-translation">
            翻訳
          </h3>

          <label className="settings__row">
            <span className="settings__label">プロバイダ</span>
            <select
              className="settings__control"
              value={settings.translation.provider}
              disabled={!loaded}
              onChange={(event) => {
                const provider = event.target.value as TranslationProviderId;
                onChange((current) => ({
                  ...current,
                  translation: { ...current.translation, provider },
                }));
              }}
            >
              {TRANSLATION_PROVIDERS.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label}
                </option>
              ))}
            </select>
          </label>

          <label className="settings__row">
            <span className="settings__label">翻訳先の言語</span>
            <select
              className="settings__control"
              value={settings.translation.targetLanguage}
              disabled={!loaded}
              onChange={(event) => {
                const targetLanguage = event.target.value;
                onChange((current) => ({
                  ...current,
                  translation: { ...current.translation, targetLanguage },
                }));
              }}
            >
              {/* A tag set by hand in settings.json is offered too, rather
                  than silently swapped for one of ours. */}
              {TARGET_LANGUAGES.some(
                (language) =>
                  language.tag === settings.translation.targetLanguage,
              ) ? null : (
                <option value={settings.translation.targetLanguage}>
                  {settings.translation.targetLanguage}
                </option>
              )}
              {TARGET_LANGUAGES.map((language) => (
                <option key={language.tag} value={language.tag}>
                  {language.label}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="settings__section" aria-labelledby="settings-keys">
          <h3 className="settings__heading" id="settings-keys">
            APIキー
          </h3>
          <p className="settings__note">
            キーはOSのキーチェーンに保存され、設定ファイルには書かれません。
            保存後は表示できません。
          </p>

          {keys.error ? (
            <p className="modal__error" role="alert">
              {keys.error}
            </p>
          ) : null}

          <ul className="keys">
            {TRANSLATION_PROVIDERS.map((provider) => {
              const configured = keys.configured?.[provider.id] ?? false;
              const busy = keys.busy === provider.id;
              const inputId = `api-key-${provider.id}`;
              return (
                <li className="keys__item" key={provider.id}>
                  <div className="keys__header">
                    <label className="keys__name" htmlFor={inputId}>
                      {provider.label}
                    </label>
                    <span className="keys__status">
                      {keys.configured === null
                        ? "確認中…"
                        : configured
                          ? "設定済み"
                          : "未設定"}
                    </span>
                  </div>
                  <div className="keys__row">
                    <input
                      id={inputId}
                      className="keys__input"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={
                        configured ? "新しいキーで置き換える" : provider.keyHint
                      }
                      value={drafts[provider.id] ?? ""}
                      disabled={busy}
                      onChange={(event) =>
                        setDraft(provider.id, event.target.value)
                      }
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        submitKey(provider.id);
                      }}
                    />
                    <button
                      type="button"
                      className="keys__button"
                      onClick={() => submitKey(provider.id)}
                      disabled={
                        busy || (drafts[provider.id] ?? "").trim() === ""
                      }
                    >
                      保存
                    </button>
                    <button
                      type="button"
                      className="keys__button keys__button--danger"
                      onClick={() => void keys.remove(provider.id)}
                      disabled={busy || !configured}
                    >
                      削除
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </div>
  );
}
