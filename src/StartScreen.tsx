import type { RecentFile } from "./files/recent";

export interface StartScreenProps {
  recentFiles: readonly RecentFile[];
  busy: boolean;
  error: string | null;
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  onOpenSettings: () => void;
}

const formatOpenedAt = (openedAt: number) =>
  new Date(openedAt).toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

export function StartScreen({
  recentFiles,
  busy,
  error,
  onOpen,
  onOpenRecent,
  onRemoveRecent,
  onOpenSettings,
}: StartScreenProps) {
  return (
    <main className="start">
      <button
        type="button"
        className="start__settings"
        onClick={onOpenSettings}
      >
        設定
      </button>
      <h1 className="start__title">Papyrus</h1>
      <p className="start__tagline">PDF viewer, built with Tauri + React.</p>

      <button
        type="button"
        className="start__open"
        onClick={onOpen}
        disabled={busy}
      >
        {busy ? "読み込み中…" : "PDFを開く"}
      </button>

      {error ? (
        <p className="start__error" role="alert">
          {error}
        </p>
      ) : null}

      <section className="recent" aria-labelledby="recent-heading">
        <h2 id="recent-heading" className="recent__heading">
          最近開いたファイル
        </h2>
        {recentFiles.length === 0 ? (
          <p className="recent__empty">まだありません。</p>
        ) : (
          <ul className="recent__list">
            {recentFiles.map((file) => (
              <li className="recent__item" key={file.path}>
                <button
                  type="button"
                  className="recent__open"
                  onClick={() => onOpenRecent(file.path)}
                  disabled={busy}
                  title={file.path}
                  aria-label={`${file.name} を開く`}
                >
                  <span className="recent__name">{file.name}</span>
                  <span className="recent__meta">
                    {formatOpenedAt(file.openedAt)}
                  </span>
                </button>
                <button
                  type="button"
                  className="recent__remove"
                  onClick={() => onRemoveRecent(file.path)}
                  aria-label={`${file.name} を一覧から削除`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
