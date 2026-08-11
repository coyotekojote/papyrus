#!/usr/bin/env bash
# src-tauri/icons/icon.svg から各サイズのアプリアイコンを作り直す。
#
#   使い方: scripts/generate-icons.sh
#
# icon.svg が唯一の原本で、他の PNG はすべてここから生成される。
# アイコンを変えるときは icon.svg を編集してこのスクリプトを実行する。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SRC="src-tauri/icons/icon.svg"
[[ -f "$SRC" ]] || { echo "原本が見つかりません: $SRC" >&2; exit 1; }

# --- SVG を 1024px の PNG にする ----------------------------------------------
# tauri icon は PNG しか受け取らないため、一度ラスタライズする必要がある。
# rsvg-convert があれば使い、なければ Chrome のヘッドレスで代用する。
# tauri icon は拡張子で入力形式を判断するため、ファイル名は .png でなければ
# ならない。mktemp のファイル名に後付けすると元の空ファイルが残るので、
# ディレクトリごと作って中に置く。
TMPDIR_ICON="$(mktemp -d -t papyrus-icon)"
PNG="$TMPDIR_ICON/icon.png"
trap 'rm -rf "$TMPDIR_ICON"' EXIT

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if command -v rsvg-convert >/dev/null 2>&1; then
  rsvg-convert -w 1024 -h 1024 -o "$PNG" "$SRC"
elif [[ -x "$CHROME" ]]; then
  # --default-background-color=00000000 を付けないと角丸の外側が白く塗られる。
  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 --default-background-color=00000000 \
    --window-size=1024,1024 --screenshot="$PNG" "$SRC" 2>/dev/null
else
  echo "SVG を変換できるツールがありません (rsvg-convert か Google Chrome が必要です)" >&2
  exit 1
fi

[[ -s "$PNG" ]] || { echo "PNG の生成に失敗しました" >&2; exit 1; }

# --- 各サイズへ展開 -----------------------------------------------------------
npx tauri icon "$PNG"

# tauri icon は Windows / Android 向けのアイコンも作るが、このプロジェクトが
# ビルドするのは macOS と iOS だけなので消しておく。
# icon.icns も作られるが、tauri.conf.json が参照するのは PNG のほうで、
# バンドル時に改めて生成されるため残さない。
cd src-tauri/icons
rm -rf android icon.ico icon.icns 64x64.png Square*Logo.png StoreLogo.png

echo "完了: src-tauri/icons と gen/apple の AppIcon を更新しました"
