# パフォーマンス最適化（Issue #12）

## 調査で確定していたホットスポット

実装前に特定していた5点（詳細は各コミットのメッセージ参照）。

1. `App.tsx` の `openPath` が `loadPageSizes` を全ページ待ち切ってから表示していた
2. `PdfJsDocument.pages`（pdf.js の `PDFPageProxy` キャッシュ）が無制限
3. `PdfJsRenderer.open()` が `data.slice()` でバイト列をフルコピーしていた
4. `PageRenderCache` が枚数固定12のLRUで、ピクセル面積を見ていなかった
5. `PdfViewer` の先読みが `OVERSCAN = 1`（同期描画範囲）のみで、スクロール方向を考慮したプリフェッチがなかった

計測基盤・ベンチマークが存在しなかったため、まずそれを整備してから1〜5に対応した。

## 計測方法

### `npm run bench`（Node ベンチ）

`bench/open.bench.mjs` が `bench/fixtures/bench.pdf`（300ページ・画像＋テキスト入り、
`scripts/generate-bench-pdf.mjs` が初回実行時に生成。`.gitignore` 対象）を pdf.js の
Node ビルド（`pdfjs-dist/legacy/build/pdf.mjs`、`disableWorker: true`）で開き、
`getDocument` と `getPage`/`getViewport`（=`loadPageSizes` が行う処理と同じ形）の時間を測る。

Node には `HTMLCanvasElement` がなく、ラスタ描画（`renderPage`）を測るには `canvas` パッケージの
ネイティブ依存が要る。今回はそこまでは入れず、ラスタ描画は次項の dev 計測に任せている。

```bash
npm run bench
```

5回実行して mean/median/min/max を出す。CI や開発機の負荷で振れるため、傾向を見る用途。

### dev ビルドでの計測（`src/perf/marks.ts`）

`performance.mark`/`measure` の薄いラッパーを、以下の4箇所に仕込んである。
`import.meta.env.DEV` の間だけ `console.debug` に `[perf] <name>: <ms>` の形で出る
（本番ビルドでは測定自体をスキップし、マークが溜まり続けることもない）。

| マーク名 | 場所 | 意味 |
|---|---|---|
| `app:read-file` | `App.tsx` `openPath` | ディスクからPDFバイト列を読む時間 |
| `pdfjs:open` | `PdfJsRenderer.open` | `getDocument` が解決するまでの時間 |
| `pdf:page-sizes` | `loadPageSizes`（非プログレッシブ版、現在は未使用経路） | 全ページサイズ取得 |
| `pdf:page-sizes-initial` / `pdf:page-sizes-background` | `loadPageSizesProgressive` | 先頭チャンク／残り全ページのサイズ取得 |
| `pdfjs:first-render-page` | `PdfJsDocument.renderPage`（そのドキュメントの最初の1回だけ） | オープンしてから最初のページが描画されるまで |

大きな実PDF（数百〜数千ページ、スキャン系）を dev ビルド (`npm run dev` → Tauri または
ブラウザ) で開き、DevTools コンソールで上記を読む運用を想定している。マシン・PDFの内容に
強く依存するため、このドキュメントには具体的な ms を固定値として書かない。

## ベンチ結果（改善前後）

`npm run bench` は pdf.js の生プリミティブ（`getDocument`/`getPage`/`getViewport`）だけを
測っており、タスク2〜5のアプリ側の変更（プログレッシブオープン・キャッシュのバジェット化・
プリフェッチ）はここには現れない ―― 変わったのは「`openPath` がこの中のどこまで待つか」で
あって、pdf.js 自体の速度ではない。したがって bench の生数値そのものは実装前後でほぼ同じになる
（下記参照）。ベンチの実測値が示しているのは、**「全ページ分待つコスト」と「先頭32ページだけ
待つコスト」の差**であり、これがタスク2で `openPath` の実際の待ち時間からどれだけ削れたかに
相当する。

改善前（このリポジトリのタスク1完了時点、`bench.pdf` = 300ページ・365KiB、5回実行）:

```text
getDocument: mean=13.5ms median=7.8ms min=6.4ms max=38.5ms
first 32 page sizes: mean=0.8ms median=0.9ms min=0.3ms max=1.5ms
all page sizes: mean=5.5ms median=5.5ms min=4.4ms max=6.9ms
open + all page sizes (pre-#12 openPath blocking cost): mean=19.0ms median=12.4ms min=12.1ms max=45.4ms
```

改善後（タスク5完了時点、同一フィクスチャ、5回実行）:

```text
getDocument: mean=14.3ms median=8.0ms min=6.4ms max=41.8ms
first 32 page sizes: mean=0.8ms median=0.8ms min=0.4ms max=1.6ms
all page sizes: mean=5.7ms median=5.6ms min=4.7ms max=7.3ms
open + all page sizes (pre-#12 openPath blocking cost): mean=20.0ms median=12.8ms min=12.4ms max=49.0ms
```

見ての通り pdf.js 自体の速度は誤差の範囲で変わっていない（想定通り）。読み取るべきは：

- 新しい `openPath` が実際にブロックするのは `getDocument` + `first 32 page sizes`
  （median 8.0ms + 0.8ms ≒ **8.8ms**）で、旧実装の `getDocument` + `all page sizes`
  （median **12.8ms**）よりこの300ページのフィクスチャでも3割強速い
- ページ数が増えるほど `all page sizes` は概ねページ数に比例して伸びる一方、
  `first 32 page sizes` はほぼ一定（32ページ分で頭打ち）。300ページで約7倍の差
  （5.6ms vs 0.8ms）なので、1000〜3000ページ級のスキャンPDFではオープンの体感待ち時間が
  数十〜百ms単位で縮む見込み（このフィクスチャでは絶対値が小さく体感しづらいため、実機での
  dev 計測を別途推奨）

## キャッシュ戦略

### `PdfJsDocument.pages`（page proxy キャッシュ、`src/pdf/pdfjs-renderer.ts`）

`Map` で無制限に溜めていたのを、既存の `LruCache`（`src/pdf/lru-cache.ts`）に置き換え、
容量64に制限した。evict 時は該当ページの `Promise` に `.then` を繋いで、解決済みなら
`page.cleanup()` を呼ぶ（未解決の in-flight なら解決を待ってから呼ぶ）。`cleanup()` は
レンダリング中など呼べない場合 `false` を返すだけで例外にはならないため、戻り値は無視している。

### `PageRenderCache`（描画済み canvas キャッシュ、`src/viewer/page-cache.ts`）

枚数上限（既定16。根拠は後述）はそのまま「安全弁」として残しつつ、総ピクセル数バジェット
（既定 `DEFAULT_PIXEL_BUDGET = 64,000,000` ≒ RGBA 約256MB）を追加した。`set` のたびに
`canvas.width * canvas.height` を積算し、バジェットを超えたら LRU の順で evict する。
挿入した1枚だけでバジェットを超える場合でも、その1枚は破棄しない —
ただしこれは **`PageCanvas` 自身の同期描画に限った前提**で、「その1枚＝直近に描画され、
画面に出ているページ」が成り立つ場合だけ安全な設計になっている。プリフェッチ（下記）は
画面に出ているとは限らないオフスクリーン canvas を `set` するため、この前提に乗らず、
副作用のない `fitsBudget(pixels)` で事前判定してからバジェットを超える場合はそもそも
`set` を呼ばない（キャッシュせず即座に破棄する）。

`PageCanvas` はキャッシュヒットした canvas をクローンせず DOM にそのまま挿すため、
evict されたページがまだ画面に出ていることが速いページめくりで起こりうる。
`onEvict` は `canvas.isConnected` を見て、DOM に接続中の canvas はバッキングストアを
ゼロ化せず（表示中のページを白くしないため。解放はそのページが実際にアンマウントされ
GC される時点まで遅延する）、接続していない canvas だけ従来どおり即ゼロ化する。枚数上限
16 は、見開き表示での worst case（可視 `OVERSCAN=1` で最大3スプレッド×2ページ=6、
プリフェッチ `PREFETCH_COUNT=3` スプレッド先読み×2ページ+背後1スプレッド×2ページ=8、
合計14）が上限内に収まるよう設定した。

### プリフェッチ（`src/viewer/virtualization.ts` の `prefetchRange`、`PdfViewer.tsx`）

スクロール量の差分（`scrollLeft` の前回値との比較）から進行方向を検出し、可視範囲
（`OVERSCAN = 1` の同期描画範囲、ここは変更していない）の外側を `requestIdleCallback`
（無い環境は `setTimeout` フォールバック）で1回のアイドルにつき1ページずつ
`PageCanvas` と同じ経路（`doc.renderPage` → オフスクリーン canvas）で温める。DOM には
一切出さない。進行方向側は `PREFETCH_COUNT`（3）スプレッド分、逆方向は最大1スプレッド分
のみ先読みする非対称設計で、方向不明時（初回描画など）は両側に均等配分する。ドキュメント
切替・スクロール位置の更新・アンマウントで `AbortController` と保留中のアイドル
コールバックの両方をキャンセルする。

描画後、`PageRenderCache.fitsBudget` でそのページ単独がピクセルバジェットを超えないか
確認し、収まる場合だけ `cache.set` する。超える場合（極端なズーム — zoom 6 × DPR 2 だと
A4 1ページで約70,000,000px、既定バジェットの64,000,000pxを単独で超える）はキャッシュせず
canvas を即座にゼロ化して破棄する。プリフェッチ由来のオフスクリーン canvas が
`PageRenderCache` の「単独でバジェットを超えても直近1枚は保持する」救済ルールに乗って
しまうと、画面に出ている全ページを押し出した上でその1枚（誰も見ていない）が居座ってしまう
——上記の「`PageRenderCache` の前提」の節参照。

## pdfium 移行の判断

**結論: 現状は pdf.js のままで十分。移行しない。**

根拠:

- 今回のベンチ（Node 上の `getDocument`/`getPage`/`getViewport`）では、pdf.js のプリミティブ
  自体は 300ページのフィクスチャで数〜十数msのオーダーであり、明確なボトルネックとして
  観測されていない
- 実際に issue で指摘されていた「重さ」は、計測してみると pdf.js の描画・パース速度ではなく
  **アプリ側の設計**（全ページ待ってから開く、キャッシュが無制限、先読みなし）に起因していた。
  タスク1〜5はすべてそちら側の是正であり、レンダラを変えずに対応できた
- `RenderPageOptions.canvas: HTMLCanvasElement` を前提にしている現在の `PdfDocumentHandle`
  抽象化（`src/pdf/types.ts`）は pdfium 移行時の課題になる。pdfium はネイティブ側（Rust）で
  ラスタライズしてピクセルバッファを返す実装が一般的で、その場合 `canvas` に直接描く代わりに
  `ImageData`/`ImageBitmap` を受け渡す形へ抽象化を広げる必要がある。テキストレイヤー
  （`renderTextLayer`）・アウトライン解決（`getOutline`）も pdf.js 固有の機能に依存しており、
  同等機能を Rust 側や別ライブラリで用意し直す必要がある

再検討の条件: 実機・実PDF（特に1000ページ超のスキャン系、または大量の画像を含むPDF）の
dev 計測（上記 `src/perf/marks.ts` のマーク）で `pdfjs:first-render-page` や個々の
`renderPage` 自体が支配的なボトルネックとして観測された場合。今回のタスクではそこまでの
負荷のPDFでの実測は行っていない。

## スコープ外（今回やらなかったこと）

- pdfium レンダラの実装（上記の通り判断のみ）
- ズーム変更時の CSS transform 仮描画（効果はあるが変更範囲が大きく、別 issue 向き）
- テキストレイヤーのキャッシュ：計測（`renderTextLayer` は `page.streamTextContent()` と
  `TextLayer` の構築のみで、`renderPage` のラスタ描画より軽いと見込まれる）はしたが、
  実機の重いPDFでの支配的コストとしては観測しておらず、キャッシュを追加する根拠が今のところ
  無いため見送った。ズームのたびに再構築している現状のままで、体感の悪化が報告されたら
  再検討する
- Rust 側のストリーミング読み込み

## Issue #35: 高速ページめくり直後の描画遅延の軽減

### 症状

ページ送りキーやホイールでの連打を止めた直後、そのとき画面にあるべきスプレッドがしばらく
白いままになることがある。恒久的に白いまま戻らないバグ（キャッシュ evict によるもの）は
PR #34 の 79ce4ce で別途修正済み — こちらはあくまで「いずれ描画はされるが、その描画が
遅れる」という体感速度の問題。

### 原因

- pdf.js の worker は直列処理で、`renderPage`（`src/pdf/pdfjs-renderer.ts`）は呼ばれた順に
  `page.render()` へ投げるだけ。アプリ側から「今どのページを優先して描画するか」を割り込ませる
  手段がなかった
- 連打中は可視 range が毎回動き、`PageCanvas` の mount → `renderPage` 開始 → 次の range で
  unmount → abort、が短時間に大量に積まれる。abort は `RenderTask.cancel()` に伝わるが、
  すでに worker に届いてしまった仕事の「順番」自体は変えられない
- 見開き表示 + `OVERSCAN = 1` では、画面上のスプレッドとその両隣のオーバースキャン分
  （最大3スプレッド×2ページ=6ページ）が同じ優先度で worker を取り合う。連打を止めた瞬間に
  見えているはずのスプレッドが、直前に通り過ぎたスプレッドの描画待ちの後ろに並んでしまう
  ことがあった

### 方式

新規モジュール `src/viewer/render-queue.ts` の `RenderQueue` を、アプリ側の描画スケジューラ
として `renderPage` 呼び出しの手前に挟んだ。

- 優先度3段階（`"visible"` > `"overscan"` > `"prefetch"`）・同時実行数1。pdf.js の worker
  自体は直列なので、アプリ側で1本に絞ることで「後から来た visible が先に worker に届く」
  余地を作る
- `schedule(priority, run, signal)` は、開始前に `signal` が abort されたらキューから除去し
  `run` を一切呼ばない（連打時の主な勝ち筋 — 通り過ぎた中間ページの描画が worker に届く前に
  消える）。実行中の abort は `run` に渡した `signal` 経由で `RenderTask.cancel()` に伝播する。
  同一優先度内は FIFO で、高優先度は常に先に dequeue される
- `PdfViewer`（`src/viewer/PdfViewer.tsx`）は overscan 込みの `range` に加え、overscan なしの
  `strictRange` を計算する。spread が `strictRange` 内なら `"visible"`、`range` 内で
  `strictRange` 外なら `"overscan"` を `PageCanvas` に渡す。`RenderQueue` はドキュメントの
  寿命ぶん `useRef` で1個だけ保持する
- `PageCanvas`（`src/viewer/PageCanvas.tsx`）は `queue`/`priority` を optional props として
  受け取り、未指定なら従来どおり即座に `doc.renderPage`（`ThumbnailList` は変更していない）。
  キャッシュヒットは `RenderQueue` を経由せず、従来どおり即座に DOM へ再アタッチする
- プリフェッチ経路（`PREFETCH_COUNT` 分の先読み、issue #12）の `doc.renderPage` 呼び出しも
  `RenderQueue` の `"prefetch"` 優先度に統合した。`requestIdleCallback` ベースの「アイドル
  1回につき1ページ」というペーシングは維持したまま、可視・overscan より優先度を下げる
- 連打中のデバウンス（`OVERSCAN_SETTLE_MS = 150`）: `strictRange` が動いてから150msの間は、
  overscan スプレッドの優先度を `"overscan"` ではなく `"prefetch"` まで落とす。`visible` の
  描画開始は一切遅らせない。`PageCanvas` のマウント自体は従来どおり即座に行う設計（`queue`/
  `priority` の切り替えのみで対応する案）にしたため、すでにキャッシュ済みのページの再表示は
  影響を受けない。150ms 経過後に優先度が `"overscan"` へ戻ると、その時点でまだキュー内に
  残っていた overscan の描画は abort → 再スケジュールされる（すでに描画が始まっていれば
  最大150ms分やり直しになりうる）。ただし重いPDFでは visible 自体の描画に150ms以上かかる
  ことが多く、overscan はその間にキュー内で自然に `"overscan"` へ昇格しているため、実害は
  ほぼないと判断した

### 確認方法

`npm run bench`（Node上で `getDocument`/`getPage`/`getViewport` のみを測る）はラスタ描画
（`renderPage`）自体を計測しないため、このIssueの検証には使えない。dev ビルドで確認する。

```bash
npm run dev
```

ページ数が多く1ページの描画に時間がかかる重いPDF（スキャン系・高解像度画像を含むもの）を
開き、矢印キーやページ送りボタンを連打してから止め、止めた瞬間のスプレッドが表示されるまでの
体感を見る。あわせて DevTools コンソールに出る `[perf] pdfjs:first-render-page: <ms>` など
`src/perf/marks.ts` 経由のマーク（「計測方法」節参照）で、連打を止めた直後に実際に描画された
ページのタイミングを確認する。
