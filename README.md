# papyrus

とっても素敵なPDF Viewer

Tauri 2 + React + TypeScript で構築するデスクトップ PDF ビューアです。

## 必要なツール

- [mise](https://mise.jdx.dev/) （Rust ツールチェーンの管理に使用）
- Node.js 24 / npm 11
- Rust（`mise install` で `mise.toml` に記載のバージョンを導入）

Rust コマンドは PATH に直接通っていない環境があるため、常に `mise exec --
cargo ...` の形で実行してください（`src-tauri` ディレクトリ内で）。

## セットアップ

```sh
mise install       # Rust ツールチェーンの導入
npm install         # フロントエンド依存関係の導入
```

## 開発

```sh
npm run tauri dev   # Tauri アプリを開発モードで起動
```

## ビルド

```sh
npm run build        # フロントエンドのビルド (tsc + vite build)
npm run tauri build   # Tauri アプリのフルビルド
```

## テスト

```sh
npm run test -- --run              # フロントエンド (Vitest)
cd src-tauri && mise exec -- cargo test   # Rust
```

## Lint / Format

```sh
npm run lint            # ESLint
npm run format           # Prettier (書き込み)
npm run format:check     # Prettier (チェックのみ)

cd src-tauri
mise exec -- cargo fmt --check
mise exec -- cargo clippy -- -D warnings
```
