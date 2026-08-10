#!/usr/bin/env bash
# 作業ツリーの内容を release ビルドして、この Mac の /Applications へ差し替える。
#
#   使い方: scripts/install-local.sh [--restart] [--no-fetch] [--dest <ディレクトリ>]
#
#     --restart   差し替え先が起動中なら、終了させて差し替え後に起動し直す
#                 (既定では起動中なら何もせず終了する)
#     --no-fetch  origin との差分チェックのための git fetch を省く
#     --dest      インストール先ディレクトリ (既定: /Applications)
#
# 終了コード: 0=差し替え完了 / 1=前提条件エラー / 2=起動中のため中断
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DEST_DIR=/Applications
RESTART=0
FETCH=1

while (($#)); do
  case "$1" in
    --restart) RESTART=1 ;;
    --no-fetch) FETCH=0 ;;
    --dest) DEST_DIR="${2:?--dest にはディレクトリを指定してください}"; shift ;;
    *) echo "不明な引数: $1" >&2; exit 1 ;;
  esac
  shift
done

BUNDLE="$REPO_ROOT/src-tauri/target/release/bundle/macos/Papyrus.app"
DEST="$DEST_DIR/Papyrus.app"
DEST_BIN="$DEST/Contents/MacOS/papyrus"

# --- 起動中チェック -----------------------------------------------------------
# 差し替え先の実行ファイルのパスで完全一致させる。他の worktree の
# target/debug/papyrus や tauri dev のインスタンスには干渉しない。
running_pids() {
  local pid comm
  while read -r pid comm; do
    [[ "$comm" == "$DEST_BIN" ]] && echo "$pid"
  done < <(ps -axo pid=,comm=)
  # while を抜けた時点の read の失敗 (=1) をそのまま返すと set -e で落ちる。
  return 0
}

pids="$(running_pids)"
if [[ -n "$pids" ]]; then
  if ((RESTART)); then
    echo "起動中の $DEST を終了します (PID: $(tr '\n' ' ' <<<"$pids"))"
    osascript -e 'quit app id "com.coyotekojote.papyrus"' >/dev/null 2>&1 || true
    for _ in {1..20}; do
      [[ -z "$(running_pids)" ]] && break
      sleep 0.5
    done
    if [[ -n "$(running_pids)" ]]; then
      echo "終了しなかったため中断します。手動で終了してから再実行してください。" >&2
      exit 2
    fi
  else
    echo "$DEST が起動中です (PID: $(tr '\n' ' ' <<<"$pids"))。" >&2
    echo "終了してから再実行するか、--restart を付けてください。" >&2
    exit 2
  fi
fi

# --- ビルド元の素性を確認 -----------------------------------------------------
# ビルドするのは HEAD ではなく作業ツリーの中身。origin/main とずれていても
# 止めはしないが、意図しない内容を本番へ入れないよう必ず表示する。
if ((FETCH)); then
  git fetch --quiet origin main || echo "警告: git fetch に失敗しました。ローカルの情報で続行します。" >&2
fi

echo "ビルド元: $(git rev-parse --short HEAD) $(git log -1 --format=%s)"
if git rev-parse --verify --quiet origin/main >/dev/null; then
  behind="$(git rev-list --count HEAD..origin/main)"
  ahead="$(git rev-list --count origin/main..HEAD)"
  # ((0)) は終了ステータス 1 なので、&& でつなぐと set -e で落ちる。if で書く。
  if ((behind)); then echo "警告: origin/main より ${behind} コミット遅れています" >&2; fi
  if ((ahead)); then echo "警告: origin/main にない ${ahead} コミットを含みます" >&2; fi
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "警告: コミットされていない変更を含んだままビルドします" >&2
fi

# --- ビルド -------------------------------------------------------------------
# --bundles app で .app だけ作る (dmg は配布しないので不要)。
echo "release ビルドを開始します"
if command -v mise >/dev/null 2>&1; then
  mise exec -- npm run tauri build -- --bundles app
else
  npm run tauri build -- --bundles app
fi

[[ -d "$BUNDLE" ]] || { echo "ビルド成果物が見つかりません: $BUNDLE" >&2; exit 1; }

# --- 差し替え -----------------------------------------------------------------
# ditto は拡張属性と署名を保ったままコピーする。cp -R では ad-hoc 署名が
# 壊れて起動できなくなることがある。
echo "$DEST へ差し替えます"
rm -rf "$DEST"
ditto "$BUNDLE" "$DEST"

# Tauri の ad-hoc 署名はバンドルに _CodeSignature を作らないため、
# codesign --verify は正常なビルドでも "code has no resources" で失敗する。
# ここでは署名が読めること (=コピーで壊れていないこと) だけを確認する。
codesign -dv "$DEST" >/dev/null 2>&1 ||
  echo "警告: 署名を読み取れませんでした。起動できるか確認してください。" >&2

echo "完了: $DEST ($(date '+%Y-%m-%d %H:%M'))"

if ((RESTART)); then
  open "$DEST"
  echo "$DEST を起動し直しました"
fi
