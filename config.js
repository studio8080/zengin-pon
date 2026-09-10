/*
 * 公開設定（秘密情報は置かない。クライアントIDとAPIキーは公開前提の値で、GCP側でリファラー制限をかける）
 *
 * ── Stripe の申し込みリンク ────────────────────────────────
 *   1. Stripe ダッシュボード → 商品 → 「全銀ポン Pro」を作成
 *        価格1: ¥480 / 月（継続）   価格2: ¥4,800 / 年（継続）
 *   2. それぞれ「支払いリンク」を作成。設定で
 *        - 「顧客のメールアドレスを収集する」をON（キーの送付先になる）
 *        - 「プロモーションコードを許可」はお好みで
 *        - 決済後のページに「ライセンスキーは1営業日以内にメールで届きます」と表示する
 *   3. 発行された https://buy.stripe.com/... を下の2つに貼る
 *   → 空のままなら料金ページのボタンは「準備中」と表示され、押しても何も起きない
 *
 * ── Googleスプレッドシート連携 ────────────────────────────
 *   1. GCP（studio@ のアカウント）でプロジェクトを作る（Firebase の kininarumono / misefits とは別でよい）
 *   2. 「APIとサービス」→ ライブラリ で Google Drive API と Google Picker API を有効化
 *   3. OAuth 同意画面: 外部 / アプリ名・サポートメール・プライバシーポリシーURL / スコープに .../auth/drive.file
 *      （drive.file は「非機密」スコープなので Google の審査は不要。公開状態を「本番」にする）
 *   4. 認証情報 → OAuth クライアントID（ウェブアプリ）。承認済み JavaScript 生成元に
 *        https://zenginpon.kokokikaku.com  と  http://localhost:8765  を登録
 *   5. 認証情報 → APIキー。アプリケーションの制限を「HTTPリファラー」にして同じURLを登録、API制限で Picker API のみ
 *   6. 下の3つを埋める（GOOGLE_APP_ID はプロジェクト番号）
 */
window.ZENGIN_CONFIG = {
  // Stripe 支払いリンク（空 = 準備中表示）
  STRIPE_LINK_MONTH: '',
  STRIPE_LINK_YEAR: '',

  // Googleスプレッドシート連携
  GOOGLE_CLIENT_ID: '',
  GOOGLE_API_KEY: '',
  GOOGLE_APP_ID: '',
};
