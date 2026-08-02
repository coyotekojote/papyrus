import { useMemo, useState } from "react";
import type { RecentFile } from "./files/recent";
import { filterLibraryFiles } from "./library/library";
import { PdfCover } from "./library/PdfCover";
import { useLibraryViewMode } from "./library/use-view-mode";

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
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useLibraryViewMode();

  const filteredFiles = useMemo(
    () => filterLibraryFiles(recentFiles, query),
    [recentFiles, query],
  );

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

      <section className="library" aria-labelledby="library-heading">
        <div className="library__header">
          <h2 id="library-heading" className="library__heading">
            最近開いたファイル
          </h2>
          {recentFiles.length > 0 ? (
            <div className="library__controls">
              <input
                type="search"
                className="library__search"
                placeholder="ファイル名で検索"
                aria-label="ライブラリを検索"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div
                className="library__modes"
                role="group"
                aria-label="表示切り替え"
              >
                <button
                  type="button"
                  className="library__mode"
                  aria-pressed={viewMode === "grid"}
                  onClick={() => setViewMode("grid")}
                >
                  表紙
                </button>
                <button
                  type="button"
                  className="library__mode"
                  aria-pressed={viewMode === "list"}
                  onClick={() => setViewMode("list")}
                >
                  ファイル名
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {recentFiles.length === 0 ? (
          <p className="recent__empty">まだありません。</p>
        ) : filteredFiles.length === 0 ? (
          <p className="recent__empty">一致するファイルがありません。</p>
        ) : viewMode === "grid" ? (
          <ul className="library__grid">
            {filteredFiles.map((file) => (
              <li className="library__tile" key={file.path}>
                <button
                  type="button"
                  className="library__cover"
                  onClick={() => onOpenRecent(file.path)}
                  disabled={busy}
                  title={file.path}
                  aria-label={`${file.name} を開く`}
                >
                  <PdfCover path={file.path} name={file.name} />
                </button>
                <div className="library__tileMeta">
                  <span className="library__tileName" title={file.name}>
                    {file.name}
                  </span>
                  <button
                    type="button"
                    className="recent__remove"
                    onClick={() => onRemoveRecent(file.path)}
                    aria-label={`${file.name} を一覧から削除`}
                  >
                    ×
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="recent__list">
            {filteredFiles.map((file) => (
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
