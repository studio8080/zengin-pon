/*
 * 公開設定（秘密情報は置かない。クライアントIDとAPIキーは公開前提の値で、GCP側でリファラー制限をかける）
 *
 * Googleスプレッドシート連携を有効にする手順:
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
  GOOGLE_CLIENT_ID: '',
  GOOGLE_API_KEY: '',
  GOOGLE_APP_ID: '',
};
