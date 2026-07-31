# Papyrus 設計ドキュメント

「最強のPDF viewer」([#1](https://github.com/coyotekojote/papyrus/issues/1)) の全体設計。

## 決定事項

| 項目 | 決定 | 理由 |
|---|---|---|
| 基盤技術 | Tauri 2 (Rust + WebView) | 1コードベースで macOS / Windows / iOS。サクサク動く要件に合致 |
| フロントエンド | React + TypeScript + Vite | pdf.js との統合実績、エコシステム |
| PDFレンダリング | pdf.js（将来 pdfium 移行の余地を残す） | テキストレイヤー・目次取得込みで実装コスト最小。ビューアはインターフェースで抽象化し、性能不足なら Rust 側 pdfium に差し替え可能にする |
| メモ・注釈の保存 | PDF横のサイドカーファイル | iCloud Drive に置けば PC⇔iOS が自動同期。「ファイルをどこに置くか」問題を解決。Obsidian 等からもメモが読める |
| 翻訳 | プロバイダ選択式（Claude / OpenAI / DeepL） | 抽象化レイヤーを Rust 側に置き、APIキーは OS キーチェーンに保存 |

## データレイアウト

PDF と同じフォルダにサイドカーを置く。ユーザーが iCloud Drive 上のフォルダを選べば同期は OS 任せ。

```
📁 Papers/                  ← ユーザーの任意フォルダ（iCloud Drive 推奨）
  attention-is-all-you-need.pdf
  attention-is-all-you-need.papyrus/
    notes.md                ← markdown メモ（他ツールからも読める素の md）
    annotations.json        ← ハイライト・線引きデータ
    clips/
      clip-0001.png         ← 切り取った図
```

### annotations.json スキーマ（v1）

```jsonc
{
  "version": 1,
  "highlights": [
    {
      "id": "uuid",
      "page": 3,
      "rects": [{ "x": 0.1, "y": 0.2, "w": 0.5, "h": 0.02 }], // ページサイズで正規化した座標
      "color": "yellow",
      "text": "抽出されたテキスト",
      "createdAt": "2026-08-01T00:00:00Z"
    }
  ],
  "clips": [
    {
      "id": "uuid",
      "page": 5,
      "rect": { "x": 0.1, "y": 0.3, "w": 0.4, "h": 0.3 },
      "file": "clips/clip-0001.png",
      "createdAt": "2026-08-01T00:00:00Z"
    }
  ]
}
```

- 座標は正規化（0〜1）で保持し、ズーム・デバイス非依存にする
- 書き込みは atomic write（tmp に書いて rename）で iCloud 同期中の破損を防ぐ

## アーキテクチャ

```mermaid
graph TB
    subgraph Frontend["WebView (React + TS)"]
        Viewer["PDF Viewer<br/>(pdf.js / 横スクロール / 見開き)"]
        Sidebar["目次サイドバー"]
        Notes["メモパネル<br/>(markdown エディタ)"]
        Annot["注釈レイヤー<br/>(ハイライト / 矩形切り取り)"]
        TransUI["翻訳ポップアップ"]
    end
    subgraph Backend["Rust (Tauri)"]
        FS["ファイルアクセス<br/>(sidecar 読み書き / atomic write)"]
        Trans["翻訳プロバイダ抽象化<br/>(Claude / OpenAI / DeepL)"]
        Keys["APIキー管理<br/>(OS キーチェーン)"]
        Clip["画像切り出し<br/>(ページ→PNG)"]
    end
    Viewer --> Annot
    Annot -->|保存| FS
    Notes -->|保存| FS
    TransUI --> Trans
    Trans --> Keys
    Annot -->|矩形| Clip
```

### 責務分担

- **フロントエンド**: レンダリング、UI状態（ページ送り・見開き・綴じ方向）、注釈の描画と編集
- **Rust側**: ファイルI/O 一切（sidecar 読み書き、atomic write）、外部API呼び出し（CORS回避 & キーをWebViewに渡さない）、APIキーのキーチェーン保存、画像切り出し

## 主要機能の設計方針

### PDF表示（#1 の中核要件）

- 横スクロールでのページ送り。単ページ / 見開きをトグル
- 左綴じ / 右綴じ切替（見開き時のページ組と、スクロール方向の反転）
- ページは仮想化して前後数ページのみレンダリング + キャッシュ（サクサク要件）

### ハイライト → 抽出

- pdf.js のテキストレイヤー上で選択 → 選択範囲の rect 群と文字列を annotations.json に保存
- ハイライト一覧から「メモに挿入」で notes.md に引用として追記

### 図の切り取り

- 矩形選択モード → 該当ページを高解像度レンダリング → 矩形部分を PNG 保存 → notes.md に `![](clips/clip-xxxx.png)` を挿入

### 翻訳

- テキスト選択 → ポップアップの「翻訳」→ Rust 側プロバイダ経由で翻訳 → 結果表示 & メモへの挿入
- Rust に `TranslationProvider` trait を定義し、Claude / OpenAI / DeepL 実装を用意
- LLM系プロバイダには前後の文脈も渡して訳質を上げる

### 音声入力（nice to have）

- まずは OS 標準のディクテーション（macOS / iOS ともテキストフィールドで利用可）に乗る。専用実装（Whisper 等）は将来検討

### iOS 対応

- Tauri 2 の iOS ターゲットでビルド
- ファイルアクセスは document picker + security-scoped bookmark。iCloud Drive のフォルダを選択して永続アクセス
- タッチ操作（スワイプでページ送り、ピンチズーム）対応

## 実装フェーズと issue 分割

```
Phase 1: 基盤        → #2 プロジェクトセットアップ / #5 サイドカーファイル基盤
Phase 2: ビューア     → #3 PDF表示コア → #4 目次サイドバー
Phase 3: 注釈・メモ   → #6 ハイライト → #7 メモパネル → #8 図の切り取り
Phase 4: 翻訳        → #9 設定・APIキー管理 → #10 翻訳機能
Phase 5: マルチデバイス → #11 iOS対応
Phase 6: 磨き込み     → #12 パフォーマンス最適化 / #13 音声入力(optional)
```

依存関係: #2 → #3 → {#4, #6, #8} 、{#5, #6} → #7 、#9 → #10 、#11 はコア機能後
