#!/usr/bin/env bash
# PR の未解決レビュースレッドを、返信に必要な ID 付きで読める形に整形して出力する。
#
#   使い方: list-open-comments.sh <PR番号>
#
# bot のコメントは HTML コメント・<details> ブロックで埋まっているので、
# それらを落として本文だけ残す。人間のコメントはそのまま出す。
#
# スレッドは --paginate で全件辿るが、1スレッド内のコメントは先頭 100 件まで。
# それを超えた場合は "[... 他 N 件]" と出力するので、必要なら Web UI で確認する。
set -euo pipefail

PR="${1:?PR番号を指定してください}"
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

gh api graphql --paginate -f query='
  query($owner: String!, $name: String!, $pr: Int!, $endCursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100, after: $endCursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            isResolved
            isOutdated
            path
            line
            comments(first: 100) {
              totalCount
              nodes {
                databaseId
                author { login __typename }
                body
              }
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
           omitted: (.comments.totalCount - (.comments.nodes | length)),
           comments: [.comments.nodes[]
                      | {author: .author.login, isBot: (.author.__typename == "Bot"), body}]}' |
  jq -r '
    "=== \(.path):\(.line // "?")\(if .isOutdated then " [outdated]" else "" end)",
    "reply-to: \(.replyTo)",
    (.comments[] | "--- @\(.author)\n" + (
      if .isBot then
        # 制御用の HTML マーカーと、解析ログ / AI 向けプロンプトの折りたたみを除去。
        # 人間のコメントには適用しない（意図して書かれた HTML を消さないため）。
        .body
        | gsub("(?s)<!--.*?-->"; "")
        | gsub("(?s)<details>.*?</details>"; "")
        | gsub("\n{3,}"; "\n\n")
        | ltrimstr("\n")
      else
        .body
      end
    )),
    (if .omitted > 0 then "[... 他 \(.omitted) 件のコメントは未取得]" else empty end),
    ""'
