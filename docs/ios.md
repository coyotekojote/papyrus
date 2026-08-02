# iOS 対応 (#11)

Papyrus を iOS 上の Tauri アプリとしてビルド・実行するための手順。実装の前提や
スコープ判断は `feature/11-ios-support` の各コミットに書いてあるので、ここでは
「どう動かすか」だけをまとめる。

## ビルド環境のセットアップ

必要なもの:

- Xcode（このリポジトリでの検証は Xcode 26.2）
- rustup の iOS ターゲット
- CocoaPods

```sh
xcode-select -p                    # Xcode が入っていることを確認
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
brew install cocoapods
```

初回のみ、Xcode プロジェクト一式を生成する:

```sh
npm run tauri ios init
```

`src-tauri/gen/apple` に Xcode プロジェクトが生成され、リポジトリにコミットされる
（`gen/apple/.gitignore` が `build/` 等のビルド成果物だけを除外する設計は Tauri 公式
テンプレートに合わせている）。プロジェクト構成そのもの（`project.yml` や
`Podfile`）を変えたときは、生成し直して差分をコミットし直すこと。

`tauri ios init` は CocoaPods や Xcode のコマンドラインツールが揃っていないと
途中で失敗する。失敗した場合は原因（CocoaPods 未導入、Xcode のライセンス未同意
`sudo xcodebuild -license` など）を潰してから再実行すればよい。他のタスク
（Rust 側の bookmark 実装、フロントの対応、レスポンシブ対応）はこの生成物と
独立に進められる。

## シミュレータでの実行

署名は不要。

```sh
npm run tauri ios dev
```

`developmentTeam`（Apple Developer のチーム ID）は `tauri.conf.json` に
ハードコードしていない。実機やアーカイブビルドで必要になったときは環境変数で渡す:

```sh
export APPLE_DEVELOPMENT_TEAM=XXXXXXXXXX
npm run tauri ios dev -- --open   # Xcode を開いて確認する場合
```

チーム ID は Xcode の Signing & Capabilities、または Apple Developer サイトの
Membership ページで確認できる。

## 実機での実行

Apple Developer Program に入っていない Personal Team でも、実機への直接インストール
（7日ごとの再署名が必要）は可能:

1. Xcode で Apple ID を追加（Xcode → Settings → Accounts）
2. `APPLE_DEVELOPMENT_TEAM` に Personal Team の ID を設定
3. `npm run tauri ios dev` で実機を選んで実行、またはワークスペースを開いて
   `src-tauri/gen/apple/papyrus.xcodeproj` から直接ビルド

## TestFlight への配布

Apple Developer Program（有償）加入が必要。

1. App Store Connect で API キーを発行（Users and Access → Keys）
2. アーカイブをビルド:
   ```sh
   export APPLE_DEVELOPMENT_TEAM=XXXXXXXXXX
   npm run tauri ios build -- --export-method app-store-connect
   ```
3. 生成された `.ipa` をアップロード:
   ```sh
   xcrun altool --upload-app \
     --type ios \
     --file path/to/papyrus.ipa \
     --apiKey <API_KEY_ID> \
     --apiIssuer <ISSUER_ID>
   ```
4. App Store Connect 上でビルドの処理完了を待ち、TestFlight のテスターに配信する

このリポジトリでの検証時点では Apple Developer Program 未加入のため、この節は
手順のみで実アップロードの動作確認はしていない。

## スコープ外にしたもの

- **フォルダ単位のライブラリ永続アクセス**: `tauri-plugin-dialog` の iOS 実装が
  フォルダ選択（`FolderPickerNotImplemented`）に対応していない。将来
  `tauri-plugin-scoped-storage` 等の採用を検討する
- **ダブルタップズーム**、pdf.js の CSS transform を使った仮ズーム最適化: #12
  （パフォーマンス最適化）の範囲
- **TestFlight への実アップロード・実機での動作確認**: 上の「実機確認チェック
  リスト」として手順化のみ。このマシンには実機・Apple Developer Program がない

## 実機確認チェックリスト

シミュレータでは確認できない項目。実機と Apple Developer Program（署名）が揃った
ときに、このリストを順に潰す。

- [ ] **キーチェーン**（issue #9）: 設定画面から翻訳プロバイダの API キーを保存 →
      アプリを再起動しても「設定済み」と表示される → 削除すると「未設定」に戻る
- [ ] **ディクテーション**: メモ欄（`notes.md` の編集エリア）でソフトウェアキーボード
      のマイクボタンから音声入力し、テキストが反映される
- [ ] **document picker から iCloud Drive の PDF を開く → 再起動 → 最近使った
      ファイルから再度開ける**（security-scoped bookmark の検証、
      `src-tauri/src/bookmarks.rs` / `src/files/open.ts`）:
      1. iCloud Drive 上の PDF を「PDFを開く」から選んで開く
      2. アプリを完全終了して再起動する
      3. 最近使ったファイル一覧から同じ PDF を開き直せることを確認する
      4. iCloud Drive 側でファイルを移動した場合は開けなくなり、一覧から
         自動的に消えることも確認する（`PdfFileMissingError` 経路）
- [ ] **スワイプでのページ送り**: 既存の `scroll-snap-type: x` + `touch-action: pan-x`
      がシミュレータのトラックパッドと実機のタッチで同じように効くこと
- [ ] **二本指ピンチズーム**（`src/viewer/touch-pinch.ts` /
      `src/viewer/PdfViewer.tsx`）: ページ上で二本指ピンチするとズームが変わり、
      WKWebView 自体が拡大されない（`gesturestart` 等の抑止が効いている）こと。
      ピンチの指を離した直後に意図しないハイライトのポップアップが出ないこと
- [ ] **コンパクト画面のレイアウト**（`src/viewer/responsive.ts` / `App.css`）:
      iPhone の縦持ちで目次・ハイライト・メモがオーバーレイ表示になり、ノッチや
      ホームバーにツールバー・ページがかぶらないこと
