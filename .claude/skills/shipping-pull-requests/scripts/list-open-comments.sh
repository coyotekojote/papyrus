#!/usr/bin/env bash
# PR の未解決レビュースレッドを、返信に必要な ID 付きで読める形に整形して出力する。
#
#   使い方: list-open-comments.sh <PR番号>
#
# bot のコメントは HTML コメント・<details> ブロック・プロンプト定型文で
# 埋まっているので、それらを落として本文だけ残す。
set -euo pipefail

PR="${1:?PR番号を指定してください}"
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

gh api graphql -f query='
  query($owner: String!, $name: String!, $pr: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100) {
          nodes {
            isResolved
            isOutdated
            path
            line
            comments(first: 20) {
              nodes { databaseId author { login } body }
            }
          }
        }
      }
    }
  }' -f owner="$OWNER" -f name="$NAME" -F pr="$PR" \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[]
        | select(.isResolved | not)
        | {path, line, isOutdated,
           replyTo: (.comments.nodes[0].databaseId),
           comments: [.comments.nodes[] | {author: .author.login, body}]}' |
  jq -r '
    "=== \(.path):\(.line // "?")\(if .isOutdated then " [outdated]" else "" end)",
    "reply-to: \(.replyTo)",
    (.comments[] | "--- @\(.author)\n" + (
      .body
      # HTML コメント（fingerprint 等の制御用マーカー）を除去
      | gsub("(?s)<!--.*?-->"; "")
      # 解析ログや AI 向けプロンプトの折りたたみを除去
      | gsub("(?s)<details>.*?</details>"; "")
      | gsub("\n{3,}"; "\n\n")
      | ltrimstr("\n")
    )),
    ""'
