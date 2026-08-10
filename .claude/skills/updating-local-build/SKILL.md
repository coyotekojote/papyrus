---
name: updating-local-build
description: papyrus を release ビルドして、この Mac の /Applications/Papyrus.app を最新版に差し替える。「本番のビルドを最新化して」「アプリを更新して」「ローカルにインストールして」「ビルドし直して入れて」と言われた時に使用。
---

# ローカルの Papyrus.app を最新ビルドに差し替える

## 実行

```bash
npm run install:local              # ビルドして /Applications へ差し替え
npm run install:local -- --restart # 起動中なら終了 → 差し替え → 起動し直す
```

実体は `scripts/install-local.sh`。ビルド（Rust の release）に 1 分前後かかるのでバックグラウンド実行が向く。

## スクリプトがやること

1. `/Applications/Papyrus.app` が起動中なら中断（`--restart` 指定時は終了 → 再起動）
2. `git fetch` して origin/main とのずれ・未コミット変更を警告（**止めはしない**）
3. `tauri build --bundles app` で release ビルド（dmg は作らない）
4. `ditto` で `/Applications/Papyrus.app` を差し替え

**ビルドされるのは HEAD ではなく作業ツリーの中身。** 警告が出たら、ユーザーの意図した内容かを確認してから続ける。

## オプション

| オプション     | 意味                                           |
| -------------- | ---------------------------------------------- |
| `--restart`    | 起動中なら終了させ、差し替え後に `open` する   |
| `--no-fetch`   | origin との差分チェック用の `git fetch` を省く |
| `--dest <dir>` | インストール先（既定 `/Applications`）         |

終了コード: `0` 差し替え完了 / `1` 前提条件エラー / `2` 起動中のため中断

## 注意点

- **他セッションのインスタンスに触らない。** 起動中判定は `/Applications/Papyrus.app/Contents/MacOS/papyrus` との完全一致。worktree の `target/debug/papyrus` や `tauri dev` は対象外なので、それらが動いていてもスクリプトは止まらないし終了もさせない
- **`codesign --verify` は正常なビルドでも失敗する。** Tauri の ad-hoc 署名はバンドルに `_CodeSignature` を作らないため `code has no resources` が出る。スクリプトは署名が読めるかだけを見ている
- 差し替え後に GUI で動作確認する場合、ユーザーのフォーカスを奪わない手順が必要
