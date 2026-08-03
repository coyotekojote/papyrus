import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useApiKeys } from "./use-api-keys";
import {
  TARGET_LANGUAGES,
  TRANSLATION_PROVIDERS,
  modelFor,
  providerInfo,
  withModel,
  type Settings,
  type TranslationProviderId,
} from "./settings";

/** What Tab can reach inside the dialog, in document order. */
const FOCUSABLE =
  "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])";

function focusableWithin(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

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
  /** The provider the model field belongs to: whichever is selected. */
  const currentProvider = providerInfo(settings.translation.provider);

  // Focus moves into the dialog so Escape and the tab order belong to it —
  // and so the viewer's page-turn shortcuts are not what the keyboard hits.
  // On the way out it goes back where it came from, so closing the dialog
  // does not drop a keyboard user at the top of the page.
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogRef.current?.focus();
    return () => opener?.focus();
  }, []);

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
    if (event.key === "Escape") {
      onClose();
      return;
    }
    // `aria-modal` tells a screen reader the rest of the page is inert; it
    // does not stop Tab from walking out of the dialog into the buttons
    // behind it — where this handler no longer runs, so the shortcuts it is
    // holding back would fire again. The cycle keeps focus in here.
    if (event.key !== "Tab") return;
    const focusable = focusableWithin(dialogRef.current);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      // Nothing to tab to: keep focus on the panel rather than let it leave.
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
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

          <label className="settings__row">
            <span className="settings__label">メモに章立てを自動挿入</span>
            <input
              type="checkbox"
              checked={settings.notesOutlineInsert}
              disabled={!loaded}
              onChange={(event) => {
                const notesOutlineInsert = event.target.checked;
                onChange((current) => ({ ...current, notesOutlineInsert }));
              }}
            />
          </label>

          <label className="settings__row">
            <span className="settings__label">
              ページ移動でメモのカーソルを追従
            </span>
            <input
              type="checkbox"
              checked={settings.notesOutlineFollow}
              disabled={!loaded}
              onChange={(event) => {
                const notesOutlineFollow = event.target.checked;
                onChange((current) => ({ ...current, notesOutlineFollow }));
              }}
            />
          </label>
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

          {/* Free text with suggestions rather than a closed list: providers
              ship models faster than this app does, and a build that only
              offered the ones it knew would go stale into unusable. */}
          <label className="settings__row">
            <span className="settings__label">
              モデル（{currentProvider.label}）
            </span>
            <input
              className="settings__control"
              type="text"
              list={`models-${currentProvider.id}`}
              autoComplete="off"
              spellCheck={false}
              placeholder={
                currentProvider.selectableModel
                  ? "既定のモデル"
                  : "選択できません"
              }
              disabled={!loaded || !currentProvider.selectableModel}
              value={modelFor(settings, currentProvider.id) ?? ""}
              onChange={(event) => {
                const model = event.target.value;
                onChange((current) =>
                  withModel(current, currentProvider.id, model),
                );
              }}
            />
          </label>
          {/* Outside the label on purpose: its options are part of a label's
              text content, and would end up in the field's accessible name. */}
          <datalist id={`models-${currentProvider.id}`}>
            {currentProvider.models.map((model) => (
              <option key={model.id} value={model.id} label={model.label} />
            ))}
          </datalist>

          <p className="settings__note">
            {currentProvider.selectableModel
              ? "空欄にすると、プロバイダごとの既定モデルを使います。モデルはプロバイダごとに覚えます。"
              : `${currentProvider.label} はモデルを選べません。`}
          </p>
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
              // Every row waits, not just the one being written: the hook
              // tracks one operation at a time, so a second one started
              // underneath the first would take over its "in flight" mark and
              // clear it early — leaving the screen looking idle mid-write.
              const busy = keys.busy !== null;
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
