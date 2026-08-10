#!/usr/bin/env bash
# PR の CI が、現在の HEAD コミットに対して出揃うまで待つ。
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

head_sha="$(gh pr view "$PR" --json headRefOid -q .headRefOid)"
echo "HEAD $head_sha を待機中"

deadline=$((SECONDS + TIMEOUT))
ci_state='(未取得)'

while ((SECONDS < deadline)); do
  # 待機中に push が入ると旧 HEAD の結果を見てしまう。HEAD が動いたらやり直す。
  current_sha="$(gh pr view "$PR" --json headRefOid -q .headRefOid 2>/dev/null || echo "$head_sha")"
  if [[ "$current_sha" != "$head_sha" ]]; then
    echo "HEAD が $current_sha に更新されたため待機し直します"
    head_sha="$current_sha"
    ci_state='(未取得)'
  fi

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
    echo "CI 通過 (必須 $(jq 'length' <<<"$ci_state") ジョブ)"
    exit 0
  fi
  sleep "$POLL_INTERVAL"
done

echo "タイムアウト (${TIMEOUT}s)"
# missing のまま終わった場合は ci.yml のジョブ名と REQUIRED_CHECKS のずれを疑う。
jq -r '.[] | select(.bucket != "pass") | "  \(.name): \(.bucket)"' <<<"$ci_state" 2>/dev/null || true
exit 1
