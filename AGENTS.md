# AGENTS.md — 全銀ポンの運用ルール

このリポジトリで作業する人（とAI）のための決まりごと。事業計画と仕様は `README.md`、
公開までの手作業は `docs/launch-checklist.md`、集客の計画は `docs/growth-plan.md`。

公開URL: https://zenginpon.kokokikaku.com/ （GitHub Pages、`main` に push すると反映される）
運営: ここ企画（https://kokokikaku.com/）

---

## 1. 絶対に守ること

1. **振込データを外に出さない。** 変換はブラウザの中だけ。読み込んだファイルの内容を送信する処理、
   解析タグに値を載せる処理を足さない。サーバーに送ってよいのはライセンスID（英数字12桁）だけ。
2. **AI・クラウドOCRを使わない。**（2026-09-03 決定）口座番号と金額の正しさは確率で決めない。
   列の推定も名義の変換も、理由を説明できるルールで書く。漢字の氏名からカナを推測しない。
3. **事実でないことをページに書かない。** 料金・制限・対応形式を変えたら、`pricing.html` `faq.html`
   `llms.txt` `tokushoho.html` `privacy.html` と、`tools/build-site.js` の構造化データ（offers）を必ず同時に直す。
   AIが「全銀ポンは完全無料」と答える状態がいちばん困る。
4. **`googleb736d92e1fe0566c.html` と `<32桁>.txt` を消さない。** 前者は Search Console の所有権確認、後者は IndexNow のキー。
5. **秘密鍵はリポジトリに入れない。** `C:\Users\chaha\.zengin-pon\license-private.pem`。失うと再発行できない。

## 2. ページの作り方（必ずこの手順）

ヘッダー・フッター・パンくず・OGP・構造化データは **HTML に静的に埋め込んである**。
JavaScript を実行しないクローラー（AIクローラーの多く）にも、メニューと運営者表記が見えるようにするため。

```
tools/site-template.js   共通部品の定義（メニュー、フッター、OGP、Organization）。ここを直すと全ページが変わる
tools/build-site.js      手書きページに部品を埋め込む + sitemap.xml を作る。PAGES にページ一覧がある
tools/build-bank-pages.js 銀行コードのページ 1,146枚を生成（同じ部品を使う）
```

- ページを足すとき: HTML を書く → `tools/build-site.js` の `PAGES` に1行足す → `node tools/build-site.js`
  → `llms.txt` の「主なページ」と、関連するページからのリンクを足す。
- 共通部品を直したとき: `node tools/build-bank-pages.js && node tools/build-site.js`。
- `<!-- site:xxx -->` の目印のあいだは**手で編集しない**（次のビルドで上書きされる）。
- push の前に `node tools/build-site.js --check` が 0 で終わること（CI でも見ている）。
- リンクは**ルート相対**（`/guide.html`）で書く。`/banks/` `/free-tools/` の配下からも同じ部品を使うため。
- 公開用のフォルダ名に `tools/` を使わない（ビルド用スクリプトの置き場と衝突する）。無料ツールは `/free-tools/`。

### 説明ページの型

冒頭の緑の枠（`.callout.ok.answer`）で**最初の2文で答えを言い切る** → 目次 → 表で具体的に → つまずく点 → 用語 → 変換ツールへの案内。
形容詞ではなく、確かめられる事実と数字を書く。1ページに h1 は1つ。

## 3. SEO・AI検索の方針

- Google は2026年5月の公式ガイドで「AI検索向けの特別な対策は不要。従来のSEOの基本が効く」と明言した。
  FAQ のリッチリザルトも同月に廃止。**小手先ではなく、独自で役に立つページと内部リンクに投資する。**
- 「全銀フォーマット 変換」の上位は、銀行・信金の配布ツール、Vector、Qiita、VBAの解説。
  正面から取りに行くのは `zengin-format.html`（仕様の解説）。ほかは**長尾で拾う**：
  銀行コード 1,146ページ、ゆうちょの記号番号、名義のカナと法人略語、銀行名×取込エラー。
- 中身の薄いページを量産しない。町名だけ差し替えたようなページは作らない。
- `llms.txt` は置く（ほかのAIが読む場合がある。Google は使わない）。**料金を含めて実態と一致させる。**
- ページの中に、AIに向けた指示文を書かない。隠しテキスト、実在しないレビューや評価の構造化データも書かない。
- `robots.txt` は検索・引用系と学習用を分けて書いてある。学習用を止めるなら該当ブロックを `Disallow: /` にする。
- ページを公開・更新したら、GitHub Pages への反映を待ってから `node tools/indexnow.js --changed`（Bing 系へ通知）。
- Search Console: 新しいページは「URL検査 → インデックス登録をリクエスト」。1日10件程度が上限。
  同じURLを何度リクエストしても早くならない。レポートは古いので、個別の URL 検査が唯一の正確な確認方法。

## 4. 法務・表示

- 法令との関係の整理は `legal.html` に公開している。条文番号を書くときは必ず原文で確かめる。
- 特商法: 運営責任者・所在地・電話番号は「請求があれば遅滞なく開示」（MenuFits / MiseFits と同じ運用）。
- サブスクの申込み前の表示（特商法12条の6）は `pricing.html#confirm`。料金や解約条件を変えたらここも直す。
- 外部に情報が送信される部品（フォント、CDN、解析、API）を足したら `privacy.html#external` の表を**先に**直す。
  いまはアクセス解析を入れていない。GA4 を入れるなら、その表と `security.html` の記述を同時に直す。
- 比較や数字には根拠を書く。「どの銀行でも使える」「最速」のような断定をしない（景品表示法）。
- アクセシビリティは「JIS X 8341-3:2016 レベルAAに配慮」。試験をしていないので「準拠」と書かない。

## 5. テストと確認

```bash
node test/zengin.test.js      # 変換エンジン
node test/organize.test.js    # 表の自動整理
node test/license.test.js     # ライセンスの発行と検証（秘密鍵が必要。CI では回さない）
node tools/build-site.js --check
python -m http.server 8877    # ローカル確認（8765 と 8790 は別プロジェクトが使っている）
```

画面を直したら、サンプルの「並びがバラバラな表で試す」を最後まで通し、スマホ幅（375px）で横スクロールが出ないことを見る。

## 6. 課金・ライセンス（要点）

Stripe のサブスク（月払い・年払い、自動更新）→ Webhook → Cloud Functions（Firebase `misefits` に codebase `zenginpon` で相乗り）
→ キーを発行してメール。キーの寿命は最長30日で、ブラウザが定期的に取り直す。解約されると 410 が返り、ブラウザがキーを消す。
デプロイは `firebase deploy --only functions:zenginpon --project misefits`。**`--only` を外さない**（Misefits の関数に触れないため）。
`index.html` の CSP `connect-src` にある cloudfunctions のドメインを消さない（消すと更新が黙って失敗する）。

## 7. ここ企画の制作実績として

- フッターの「企画・開発・運営：ここ企画」は会社サイトへの外部リンク。`about.html` に制作メモがある。
- Organization の `@id` は会社サイトと同じ `https://kokokikaku.com/#organization`。
- 会社サイト（`C:\Users\chaha\projects\kokokikaku-web`、GitHub は `mikan-koko`）の制作実績・`llms.txt`・ItemList に全銀ポンを載せる。
  **そのリポジトリは main への push で本番に出る。** 変更はブランチで用意し、運営者が確認してから反映する。
