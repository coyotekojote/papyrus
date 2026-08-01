#!/usr/bin/env bash
# PR の CI と CodeRabbit のレビューが、現在の HEAD コミットに対して出揃うまで待つ。
#
#   使い方: wait-for-review.sh <PR番号> [タイムアウト秒]
#
# 標準出力に進捗を1行ずつ出し、揃ったら 0 で終了する。
# タイムアウトした場合は 1、CI が失敗またはスキップされた場合は 2 で終了する。
set -euo pipefail

PR="${1:?PR番号を指定してください}"
TIMEOUT="${2:-1200}"
POLL_INTERVAL=30

# .github/workflows/ci.yml の各ジョブの name。ここに挙げたジョブが
# すべて pass した時だけ CI 完了とみなす。bot が出すチェック
# (copilot-pull-request-reviewer など) を CI と数えないための明示リスト。
REQUIRED_CHECKS='[
  "Frontend (lint / format / test / build)",
  "Rust (fmt / clippy / test)",
  "Tauri build (no bundle)"
]'

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
head_sha="$(gh pr view "$PR" --json headRefOid -q .headRefOid)"
echo "HEAD $head_sha を待機中"

deadline=$((SECONDS + TIMEOUT))
ci_done=false
review_done=false
ci_state='(未取得)'

while ((SECONDS < deadline)); do
  if ! $ci_done; then
    checks="$(gh pr checks "$PR" --json name,bucket 2>/dev/null || echo '[]')"
    # 必須ジョブごとに bucket を引く。まだ登録されていないジョブは "missing"。
    ci_state="$(jq -c --argjson req "$REQUIRED_CHECKS" \
      '[$req[] as $n | {name: $n, bucket: ([.[] | select(.name == $n) | .bucket] | first // "missing")}]' \
      <<<"$checks")"

    bad="$(jq -r '[.[] | select(.bucket | IN("fail", "cancel", "skipping")) | "\(.name)=\(.bucket)"] | join(", ")' <<<"$ci_state")"
    if [[ -n "$bad" ]]; then
      echo "CI 失敗: $bad"
      exit 2
    fi
    if jq -e 'all(.bucket == "pass")' <<<"$ci_state" >/dev/null; then
      ci_done=true
      echo "CI 通過 (必須 $(jq 'length' <<<"$ci_state") ジョブ)"
    fi
  fi

  if ! $review_done; then
    # CodeRabbit は commit status ("CodeRabbit") をレビュー中 pending、完了で
    # success にする。レビューの存在だけを見ると、本文が空のレビューが先に
    # API へ現れる場合があり、まだ進行中なのに完了と誤認する。status が権威。
    cr_status="$(gh api "repos/$REPO/commits/$head_sha/status" \
      --jq '[.statuses[] | select(.context == "CodeRabbit")] | last | .state // "missing"' 2>/dev/null || echo missing)"
    case "$cr_status" in
      failure | error)
        echo "CodeRabbit のレビューが失敗: $cr_status"
        exit 2
        ;;
      success)
        # commit_id で照合する。submitted_at の比較では、rebase や cherry-pick で
        # コミット日時が過去のまま push された場合に旧レビューを取り違える。
        reviews="$(gh api "repos/$REPO/pulls/$PR/reviews" --paginate --slurp 2>/dev/null || echo '[]')"
        latest="$(jq -r --arg sha "$head_sha" \
          '[.[][] | select(.user.login == "coderabbitai[bot]" and .commit_id == $sha and .submitted_at != null) | .submitted_at]
           | sort | last // empty' <<<"$reviews")"
        if [[ -n "$latest" ]]; then
          review_done=true
          echo "CodeRabbit のレビュー完了 ($latest)"
        fi
        ;;
    esac
  fi

  if $ci_done && $review_done; then
    exit 0
  fi
  sleep "$POLL_INTERVAL"
done

echo "タイムアウト (${TIMEOUT}s): CI=$ci_done レビュー=$review_done"
# missing のまま終わった場合は ci.yml のジョブ名と REQUIRED_CHECKS のずれを疑う。
jq -r '.[] | select(.bucket != "pass") | "  \(.name): \(.bucket)"' <<<"$ci_state" 2>/dev/null || true
$review_done || echo "  CodeRabbit (commit status): ${cr_status:-未取得}"
exit 1
