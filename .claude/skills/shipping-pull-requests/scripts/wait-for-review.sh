#!/usr/bin/env bash
# PR の CI と CodeRabbit のレビューが、現在の HEAD コミットに対して出揃うまで待つ。
#
#   使い方: wait-for-review.sh <PR番号> [タイムアウト秒]
#
# 標準出力に進捗を1行ずつ出し、揃ったら 0 で終了する。
# タイムアウトした場合は 1、CI が失敗した場合は 2 で終了する。
set -euo pipefail

PR="${1:?PR番号を指定してください}"
TIMEOUT="${2:-1200}"
POLL_INTERVAL=30

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

head_sha="$(gh pr view "$PR" --json headRefOid -q .headRefOid)"
# レビューが「この push より後」かを判定する基準時刻。
head_time="$(gh api "repos/$REPO/commits/$head_sha" -q .commit.committer.date)"
echo "HEAD $head_sha ($head_time) を待機中"

deadline=$((SECONDS + TIMEOUT))
ci_done=false
review_done=false

while ((SECONDS < deadline)); do
  if ! $ci_done; then
    # checks が空 = まだ1つも登録されていない。pending 扱いにする。
    checks="$(gh pr checks "$PR" --json name,bucket 2>/dev/null || echo '[]')"
    if [[ "$(jq 'length' <<<"$checks")" -gt 0 ]] &&
      jq -e 'all(.bucket != "pending")' <<<"$checks" >/dev/null; then
      ci_done=true
      failed="$(jq -r '.[] | select(.bucket == "fail" or .bucket == "cancel") | .name' <<<"$checks")"
      if [[ -n "$failed" ]]; then
        echo "CI 失敗: $(tr '\n' ',' <<<"$failed")"
        exit 2
      fi
      echo "CI 通過 ($(jq 'length' <<<"$checks") チェック)"
    fi
  fi

  if ! $review_done; then
    # HEAD コミットより後に CodeRabbit がレビューを提出していれば完了とみなす。
    latest="$(gh api "repos/$REPO/pulls/$PR/reviews" --paginate \
      -q "[.[] | select(.user.login == \"coderabbitai[bot]\" and .submitted_at > \"$head_time\")] | last | .submitted_at // empty" 2>/dev/null || true)"
    if [[ -n "$latest" ]]; then
      review_done=true
      echo "CodeRabbit のレビュー到着 ($latest)"
    fi
  fi

  if $ci_done && $review_done; then
    exit 0
  fi
  sleep "$POLL_INTERVAL"
done

echo "タイムアウト (${TIMEOUT}s): CI=$ci_done レビュー=$review_done"
exit 1
