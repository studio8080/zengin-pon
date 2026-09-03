/*
 * gsheets.js — Googleスプレッドシートを「ピッカーで選んで直接読む」
 *
 * 仕組み（サーバー不要・データはブラウザとGoogleの間だけを通る）
 *   1. Google Identity Services でアクセストークンを取る（スコープ drive.file = 利用者が選んだファイルだけ）
 *   2. Google Picker でスプレッドシートを選ばせる（Picker経由で選んだファイルは drive.file の対象になる）
 *   3. Drive API の files.export で xlsx として取得 → 既存の SheetJS 経路に流す
 *
 * 必要な設定（config.js）
 *   GOOGLE_CLIENT_ID : GCP の OAuth 2.0 クライアントID（ウェブアプリ）。承認済みの JavaScript 生成元に公開URLとローカルURLを登録
 *   GOOGLE_API_KEY   : GCP の APIキー（Picker用。HTTPリファラー制限をかける）
 *   GOOGLE_APP_ID    : GCP のプロジェクト番号（Picker の setAppId 用）
 * GCP 側で「Google Picker API」と「Google Drive API」を有効化しておく。
 */
(function () {
  'use strict';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  let tokenClient = null, accessToken = null, pickerReady = false, gisReady = false;

  function cfg() { return window.ZENGIN_CONFIG || {}; }
  function configured() { const c = cfg(); return !!(c.GOOGLE_CLIENT_ID && c.GOOGLE_API_KEY); }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error(`読み込み失敗: ${src}`));
      document.head.appendChild(s);
    });
  }

  async function init() {
    if (!configured()) throw new Error('Googleスプレッドシート連携はまだ設定されていません（config.js に GOOGLE_CLIENT_ID / GOOGLE_API_KEY を設定してください）');
    await Promise.all([
      loadScript('https://accounts.google.com/gsi/client'),
      loadScript('https://apis.google.com/js/api.js'),
    ]);
    if (!gisReady) {
      tokenClient = google.accounts.oauth2.initTokenClient({ client_id: cfg().GOOGLE_CLIENT_ID, scope: SCOPE, callback: () => {} });
      gisReady = true;
    }
    if (!pickerReady) {
      await new Promise((resolve, reject) => gapi.load('picker', { callback: resolve, onerror: reject }));
      pickerReady = true;
    }
  }

  function getToken() {
    return new Promise((resolve, reject) => {
      tokenClient.callback = (resp) => {
        if (resp.error) return reject(new Error(`Googleの認可に失敗しました: ${resp.error}`));
        accessToken = resp.access_token; resolve(accessToken);
      };
      tokenClient.requestAccessToken({ prompt: accessToken ? '' : 'consent' });
    });
  }

  function showPicker(token) {
    return new Promise((resolve) => {
      const view = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS).setIncludeFolders(true).setMode(google.picker.DocsViewMode.LIST);
      const builder = new google.picker.PickerBuilder()
        .setOAuthToken(token)
        .setDeveloperKey(cfg().GOOGLE_API_KEY)
        .setLocale('ja')
        .addView(view)
        .setTitle('振込一覧のスプレッドシートを選ぶ')
        .setCallback((data) => {
          if (data.action === google.picker.Action.PICKED) resolve(data.docs[0]);
          else if (data.action === google.picker.Action.CANCEL) resolve(null);
        });
      if (cfg().GOOGLE_APP_ID) builder.setAppId(cfg().GOOGLE_APP_ID);
      builder.build().setVisible(true);
    });
  }

  /**
   * 利用者にシートを選ばせ、xlsx の ArrayBuffer と名前を返す。キャンセル時は null。
   * @returns {Promise<{name:string, buffer:ArrayBuffer}|null>}
   */
  async function pickSpreadsheet() {
    await init();
    const token = await getToken();
    const doc = await showPicker(token);
    if (!doc) return null;
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(doc.id)}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`スプレッドシートの取得に失敗しました（${res.status}）`);
    return { name: `${doc.name}.xlsx`, buffer: await res.arrayBuffer() };
  }

  window.GSheets = { configured, pickSpreadsheet };
})();
