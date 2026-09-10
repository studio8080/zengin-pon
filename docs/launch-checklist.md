# 全銀ポン 公開チェックリスト

最終更新: 2026-09-10。**あなたの操作が必要なもの**だけをここに集めた。
コードで済むものは実装済みで、このファイルには出てこない。

上から順に進めれば公開できる。1と2が終われば「サイトが見える」、3が終われば「売れる」。

---

## 1. DNS を設定してサイトを見えるようにする — **完了済み（2026-09-10）**

`CNAME zenginpon → studio8080.github.io` を追加済み。既存レコード（A@ / MX / www / menufits /
misefits / pitch / TXT各種）は変更していない。**サイトは https://zenginpon.kokokikaku.com/ で表示される。**

残: GitHub の証明書発行を待って **Settings → Pages → Enforce HTTPS にチェック**（発行後に押せるようになる）。

<details><summary>やった手順（記録）</summary>

1. Squarespace の DNS 管理画面を開く（`kokokikaku.com`。ログインは **`mikan@kokokikaku.com`**）
   - Xserver ではない。`kokokikaku.com` は Squarespace 管理。
2. レコードを追加する
   | 項目 | 値 |
   |---|---|
   | ホスト | `zenginpon` |
   | 種別 | **CNAME** |
   | 値 | `studio8080.github.io` |
3. 保存する

> ⚠️ 種別のドロップダウンは誤選択しやすい（過去に NS / MX を誤って選んだ事故あり）。
> **種別は手で選び、保存前に一覧の表示を読んで照合すること。**
> 既存の `@` の A レコード、`MX`、`www`、`menufits` / `misefits` / `pitch` の3件には触らない。

</details>

**確認コマンド**

```bash
nslookup zenginpon.kokokikaku.com
```


---

## 2. 特定商取引法に基づく表記を埋める（所要 5分）

`tokushoho.html` の以下が `（…を記載）` のままだと**有料販売ができない**（特商法違反になる）。

| 項目 | 現状 | 入れるもの |
|---|---|---|
| 運営責任者 | `（氏名を記載）` | 代表者の氏名 |
| 所在地 | `（住所を記載）` | 事業所の住所。「請求があれば遅滞なく開示します」でも可だが、**Stripe の審査では実住所を求められることがある** |
| 電話番号 | 「請求があれば開示」 | このままで可 |

インボイス登録なしの旨は記載済み。修正したら push すれば反映される。

---

## 3. Stripe で支払いリンクを作る（所要 20分）

### 3-1. 商品と価格 — **完了済み**

商品「全銀ポン Pro」（`prod_VEa5100IEJu6JE`）に ¥480/月 と ¥4,800/年 を作成済み。
商品税コードは **サービスとしてのソフトウェア (SaaS): 業務使用**（`txcd_10103001`）。

<details><summary>やった手順（記録）</summary>

Stripe ダッシュボード → 商品 → 商品を追加

- 商品名: `全銀ポン Pro`
- 説明: `全銀フォーマット変換ツール 全銀ポンの有料プラン。件数無制限、テンプレート保存、振込元プロファイル、変換履歴、バックアップ。`
- 価格を2つ作る（どちらも**継続**、通貨 JPY、**税込表示**）
  - `¥480` / 月
  - `¥4,800` / 年

</details>

### 3-2. 支払いリンクを2本作る — **完了済み**

<details><summary>やった設定（記録）</summary>

商品 → 各価格 → 「支払いリンクを作成」

必ずこう設定する。

- **顧客のメールアドレスを収集する: ON**（キーの送付先になる。これが無いと誰に送るか分からない）
- 決済後の表示: カスタムメッセージにする
  ```
  お申し込みありがとうございます。
  ライセンスキーを1営業日以内（多くの場合は数時間以内）にメールでお送りします。
  届いたキーを全銀ポンの「⭐ Pro」ボタンから入力してください。
  ```
- 「請求書を顧客に送信」ON（領収書メールが自動で届く）

</details>

### 3-3. サイトに反映する — **完了済み**

`config.js` に貼り済み。料金ページの「Proを申し込む」から購入できる状態。

| プラン | 支払いリンク |
|---|---|
| 月払い ¥480 | https://buy.stripe.com/4gM8wI0lA03i5zl3dV9R602 |
| 年払い ¥4,800 | https://buy.stripe.com/8x2bIU5FU2bqaTFbKr9R603 |

**販売を一時停止したいとき**は `config.js` の2行を `''` に戻して push すれば「準備中」に戻る。

> ⚠️ **銀行での取込テスト（第8節）が終わるまでは、SNSや広告での告知を控えること。**
> リンクは有効なので、URLを知っている人は購入できる。

> ⚠️ **Managed Payments が有効で、取引あたり 3.5% の手数料が上乗せされる**（通常のStripe手数料に加えて）。
> Stripeがグローバルな税務コンプライアンスと不正利用対応を代行する仕組み。国内のみの販売なら
> 外すことも検討する価値がある（¥480 の取引で ¥17 前後の差）。決済リンクの編集画面で切り替えられる。

---

## 3-4. 月払いを自動化する（Cloud Functions のデプロイ）

年払いだけで始めるなら飛ばしてよい。**月払いを売るならここまでやる**（解約されたら止まる仕組み）。

### 仕組み

```
Stripe（支払い成功）──webhook──▶ zenginponStripeWebhook
                                  ├─ キーを発行（期限＝今期末＋5日）
                                  ├─ Firestore に保存
                                  └─ 購入者にメール

ブラウザ（期限10日前）──ライセンスIDのみ──▶ zenginponLicense ──▶ 新しいキー
```

解約すると次の請求が来ないので、支払い済み期間の末日＋5日でキーが自然に切れる。

### 手順

既存の Firebase プロジェクト **`misefits`**（Blaze 設定済み）に、別コードベース `zenginpon` として相乗りする。
新しいプロジェクトも課金設定も要らない。**コードベースを分けてあるので Misefits の関数は消えない。**

1. 依存を入れる
   ```bash
   cd functions && npm install && cd ..
   ```
2. シークレットを登録する（`misefits` プロジェクトに追加される）
   ```bash
   firebase functions:secrets:set ZP_LICENSE_PRIVATE_KEY
   ```
   → `C:\Users\chaha\.zengin-pon\license-private.pem` の中身を**全文貼り付け**（`-----BEGIN` から `-----END PRIVATE KEY-----` まで）
   ```bash
   firebase functions:secrets:set ZP_STRIPE_WEBHOOK_SECRET
   ```
   → 手順4で Stripe が出す `whsec_...`（先に空で登録し、あとで入れ直してもよい）

   `STRIPE_SECRET_KEY` `SMTP_USER` `MAIL_FROM` `SMTP_PASS` は Misefits で登録済みのものが共有される。
3. `functions/.env` を作る（`.env.example` をコピー。`SMTP_HOST` と `SMTP_PORT` を書く）
4. デプロイする
   ```bash
   firebase deploy --only functions:zenginpon
   ```
   → 2つのURLが表示される。控える。
   - `https://asia-northeast1-misefits.cloudfunctions.net/zenginponStripeWebhook`
   - `https://asia-northeast1-misefits.cloudfunctions.net/zenginponLicense`
5. Stripe → 開発者 → Webhook → エンドポイントを追加
   - URL: 上の `zenginponStripeWebhook`
   - 送信するイベント: `checkout.session.completed` / `invoice.paid` /
     `customer.subscription.deleted` / `customer.subscription.updated`
   - 表示された署名シークレット `whsec_...` を手順2の `ZP_STRIPE_WEBHOOK_SECRET` に入れて再デプロイ
6. `config.js` の `LICENSE_API` に `zenginponLicense` のURLを入れて push
7. テストモードで1回購入し、キーがメールで届くこと・「⭐ Pro」で有効になることを確認する

---

## 4. 申し込みが来たときの作業（1件あたり 3分）

Stripe から決済通知メールが届いたら、次を実行する。

```bash
node tools/issue-key.js --months 12 --mail --memo "buyer@example.com"
```

- 月払いなら `--months 1`、年払いなら `--months 12`
- `--mail` を付けると**そのまま送れるメール文面**が出る。件名と本文をコピーして送るだけ
- 発行記録は `tools/issued-keys.csv` に自動で追記される（Git には入らない）

**手順3-4（Cloud Functions）を済ませていれば、この作業は不要**。支払いのたびに自動で発行・送信される。
この節は、Functions を入れる前に売り始めた場合と、返金・特例対応のための手動発行用。

### 更新のとき

期限が近い購入者（`tools/issued-keys.csv` で分かる）に、新しいキーを同じ手順で発行して送る。
古いキーは期限切れで自動的に使えなくなるので、無効化の作業は不要。

---

## 5. 秘密鍵のバックアップ（**いま必ずやる**）

```
C:\Users\chaha\.zengin-pon\license-private.pem
```

**このファイルを失うと、以後ライセンスキーを発行できなくなる**（既存の購入者のキーは期限まで有効なままだが、
新規発行と更新ができなくなり、公開鍵を差し替えて全員に再発行する羽目になる）。

- パスワードマネージャーの「セキュアメモ」に中身を貼って保存する
- 共有ドライブ（`H:\`）にはコピーしない（同期先から漏れる）

---

## 6. Search Console に登録する（所要 10分。DNS 反映後）

1. https://search.google.com/search-console/ を開く（**`studio@kokokikaku.com`**）
2. プロパティを追加 → 「URLプレフィックス」→ `https://zenginpon.kokokikaku.com/`
3. 所有権の確認 → HTMLタグ方式を選び、表示された `<meta name="google-site-verification" ...>` を
   `index.html` の `<head>` に貼って push（反映後に「確認」を押す）
4. サイトマップ → `sitemap.xml` を送信

銀行コードのページが1,146枚あるので、インデックスには数週間かかる。

---

### 6-2. アクセス解析（GA4）を入れる

`config.js` の `GA_MEASUREMENT_ID` に GA4 の測定ID（`G-XXXXXXXXXX`）を入れて push すれば有効になる。
入れなければ解析タグは読み込まれない。

> ⚠️ **`security.html` と `privacy.html` には「Googleアナリティクスで集計します」と書いてある。**
> 解析を入れない方針にするなら、この2ページの該当行を消すこと（書いてあるのに使っていない状態も、
> 使っているのに書いていない状態も避ける）。

---

## 7. Googleスプレッドシート連携を有効にする（所要 30分。後回しで可）

`config.js` の冒頭コメントに手順を書いてある。GCP でプロジェクトを作り、
Drive API と Picker API を有効化し、OAuth クライアントIDとAPIキーを作って3つの値を埋める。

**未設定でも他の機能は全部動く**（ボタンを押すと「Excelで保存して読み込んでください」と案内が出る）。
公開を急ぐなら後回しでよい。

---

## 8. 公開前の最終確認

- [ ] https://zenginpon.kokokikaku.com/ が HTTPS で開く
- [ ] サンプルCSV（並びがバラバラなもの）で変換 → ダウンロードできる
- [ ] 料金ページの「Proを申し込む」が Stripe に飛ぶ
- [ ] 特商法ページに氏名・住所が入っている
- [ ] 自分で1回テスト購入して、キー発行 → 有効化まで通す（Stripe のテストモードでも可）
- [ ] **自社の口座で少額1件だけ実際に振込データを作り、銀行に取り込んで通ることを確認する**
      （これが最重要。銀行ごとの取込条件が想定どおりか、実物で確かめる）

---

## 参考: 公開後にやること（優先順）

1. 主要行の取込結果を集めて `guide.html` の銀行別表を実データに更新する
2. `data/merged.json` に直近の統廃合（旧→新コード）を実データで埋める
3. 銀行別の取込手順を独立ページにして記事を増やす（検索流入）
4. Stripe Webhook でキー発行を自動化する
5. 全銀ファイル → Excel の逆変換（入金データの読み取り）
