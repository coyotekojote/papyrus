---
name: shipping-pull-requests
description: papyrus で PR を作成し、CodeRabbit / Copilot のレビューが尽きるまで対応を繰り返してマージ可能な状態にする。「PR作って」「PR出して」「レビュー対応して」「レビューコメント見て」「レビューが終わるまで回して」と言われた時に使用。
---

# PR を作ってレビューが尽きるまで回す

実装が終わった状態から、PR を出し、CodeRabbit のレビューに対応し、指摘が出なくなるまで繰り返す。

## 全体の流れ

```text
1. ブランチを切ってコミット・push
2. PR 作成
3. CI とレビューが出揃うまで待つ        ← scripts/wait-for-review.sh
4. 未解決コメントを読む                  ← scripts/list-open-comments.sh
5. 各コメントに「対応」か「対応しない理由」を返信
   → 修正があれば commit & push して 3 に戻る
   → 未解決 0 件なら完了。マージするかユーザーに確認
```

**ユーザーの明示的な指示なしにマージしない。** 収束したら報告して判断を仰ぐ。

## 1. PR を作成する

`main` がデフォルトブランチ。直接コミットせず必ずブランチを切る。

```bash
git checkout -b <type>/<summary>   # feature/ fix/ chore/ docs/
git add <files> && git commit -F - <<'EOF'
<件名>

<本文>

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: <session URL>
EOF
git push -u origin HEAD
gh pr create --base main --title "<日本語のタイトル>" --body "$(cat <<'EOF'
## 概要
...
EOF
)"
```

push 前にローカルで CI 相当を通しておくと往復が減る。

```bash
npm run lint && npm run format:check && npm run test -- --run && npm run build
# src-tauri を触った場合
cd src-tauri && mise exec -- cargo fmt --check && mise exec -- cargo clippy -- -D warnings && mise exec -- cargo test
```

## 2. CI とレビューを待つ

```bash
.claude/skills/shipping-pull-requests/scripts/wait-for-review.sh <PR番号> [タイムアウト秒]
```

必須の CI 3 ジョブ（Frontend / Rust / Tauri build）が揃って `pass` になり、かつ **現在の HEAD コミットに対する** CodeRabbit のレビューが提出されるまでブロックする。終了コード: `0` 揃った / `1` タイムアウト / `2` CI が失敗またはスキップ。

必須ジョブ名はスクリプト内の `REQUIRED_CHECKS` にある。`.github/workflows/ci.yml` のジョブ名を変えたらここも直す（放置するとタイムアウトするまで `missing` のまま待ち続ける）。

数分かかるので、Bash ツールの `run_in_background: true` で起動して完了通知を待つ。手動で `sleep` を回さないこと。

CI が失敗した (`2`) 場合はレビュー対応より先に CI を直す。

```bash
gh run view --log-failed -R coyotekojote/papyrus   # 失敗ジョブのログ
```

## 3. 未解決コメントを読む

```bash
.claude/skills/shipping-pull-requests/scripts/list-open-comments.sh <PR番号>
```

未解決の review thread だけを、`reply-to: <ID>` 付きで出力する。bot のコメントからは HTML マーカーと `<details>`（解析ログ・AI 向けプロンプト）を除去する。人間のコメントは加工しない。

スレッドは全件辿るが、1スレッド内のコメントは先頭 100 件まで。超えた分は `[... 他 N 件のコメントは未取得]` と出るので、その時は Web UI で確認する。

PR 全体のサマリレビューも確認する。

```bash
gh pr view <PR番号> --json reviews --jq '.reviews[] | "@\(.author.login) [\(.state)]\n\(.body)"'
```

CodeRabbit のサマリに出る **`Actionable comments posted: N`** が、その周で対応すべき件数。

## 4. 一件ずつ判断して返信する

指摘を鵜呑みにしない。**まず現在のコードに対して指摘が成立するか検証する。** 設定ファイルやライブラリの挙動に関する指摘なら、公式スキーマやドキュメントを実際に取得して裏を取る。

例（CodeRabbit の設定スキーマを検証する）:

```bash
curl -sL https://coderabbit.ai/integrations/schema.v2.json -o /tmp/schema.json
node -e "const s=require('/tmp/schema.json'); console.log(JSON.stringify(s.properties.reviews.properties.<key>,null,1))"
```

判断は3通り。**どれを選んでも必ず返信する。黙って無視しない。**

| 判断         | やること                                    |
| ------------ | ------------------------------------------- |
| 妥当         | 修正してコミット。返信でコミット SHA を示す |
| 部分的に妥当 | 対応する範囲と、対応しない範囲＋理由を返信  |
| 不適切       | 修正せず、なぜ成立しないかを根拠付きで返信  |

返信はスレッドに紐づける。`<ID>` は `list-open-comments.sh` の `reply-to`。

```bash
gh api "repos/coyotekojote/papyrus/pulls/<PR番号>/comments/<ID>/replies" -X POST -f body='...'
```

パスは1つの引数として渡す（`-X POST` の前後でスペースを入れて分割すると `accepts 1 arg(s)` で落ちる）。

修正内容が PR の説明と食い違ってきたら本文も更新する。

```bash
gh pr edit <PR番号> --body "$(cat <<'EOF'
...
EOF
)"
```

## 5. 収束判定

push すると CodeRabbit が増分レビューを返すので、2 に戻る。次のすべてを満たしたら完了:

- `list-open-comments.sh` の出力が空
- 直近の CodeRabbit レビューが `Actionable comments posted: 0`、または新しいレビューが付かない
- CI が全て通過

同じ指摘が3周以上続く、または CodeRabbit と自分の判断が食い違って決着しない場合は、ループを止めてユーザーに判断を仰ぐ。

## リポジトリ固有のメモ

- CodeRabbit App はインストール済み。設定は `.coderabbit.yaml`（レビュー言語は日本語、`profile: chill`、Request changes なし）
- Finishing Touches は全て無効化済み。CodeRabbit はコードを書かない。修正は必ず自分で入れる
- Copilot もレビューを付けることがあるが、毎回は走らない。待機条件には含めない。付いていたら同じ手順で対応する
- CI は macOS ランナーで3ジョブ。Tauri build は frontend / rust の後に走るため全体で数分かかる
