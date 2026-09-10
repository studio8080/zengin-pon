/*
 * license.js — Pro ライセンスキーの検証（サーバー不要）
 *
 * キーの形式:  ZP1-<base64url(payload JSON)>.<base64url(Ed25519 署名 64バイト)>
 *   payload = { v:1, p:"pro", e:"YYYY-MM-DD"(有効期限), id:"発行ID" }
 *
 * 発行は tools/issue-key.js（秘密鍵はリポジトリ外）。ブラウザは埋め込んだ公開鍵で署名を検証するだけなので、
 * 通信も課金サーバーも要らない。期限が来たら新しいキーを発行して送る（更新）。
 * 台数制限（2台）は技術的には強制しない。規約上の約束として扱う。
 *
 * Node でも動く（テスト用）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.License = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const PUBLIC_KEY = 'OIwfbUMa9__rkLw72kjwZr7akX27nG9AjM11tcpp-ng'; // Ed25519 公開鍵（生32バイト, base64url）
  const STORAGE = 'zenginpon.license';

  function b64uToBytes(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = (typeof atob === 'function') ? atob(s) : Buffer.from(s, 'base64').toString('binary');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function subtle() {
    if (typeof crypto !== 'undefined' && crypto.subtle) return crypto.subtle;
    try { return require('node:crypto').webcrypto.subtle; } catch (_) { return null; }
  }

  let pubKeyPromise = null;
  function publicKey() {
    if (!pubKeyPromise) pubKeyPromise = subtle().importKey('raw', b64uToBytes(PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']);
    return pubKeyPromise;
  }

  /** 文字列を解析して署名と期限を検証する。 */
  async function verify(keyStr, today) {
    const s = String(keyStr || '').trim().replace(/\s+/g, '');
    const m = s.match(/^ZP1-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
    if (!m) return { ok: false, reason: 'キーの形式が違います（ZP1- で始まる文字列をそのまま貼り付けてください）' };
    let payload;
    try { payload = JSON.parse(new TextDecoder().decode(b64uToBytes(m[1]))); } catch (_) { return { ok: false, reason: 'キーを読み取れません' }; }
    let sigOk = false;
    try { sigOk = await subtle().verify({ name: 'Ed25519' }, await publicKey(), b64uToBytes(m[2]), b64uToBytes(m[1])); } catch (_) { sigOk = false; }
    if (!sigOk) return { ok: false, reason: 'キーが正しくありません（コピー漏れがないか確認してください）', payload };
    if (payload.v !== 1 || payload.p !== 'pro' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.e || '')) return { ok: false, reason: 'このキーは対応していません', payload };
    const t = today || new Date().toISOString().slice(0, 10);
    if (payload.e < t) return { ok: false, reason: `有効期限（${payload.e}）が切れています。更新するとまた使えます`, payload, expired: true };
    return { ok: true, payload, expiry: payload.e };
  }

  function stored() { try { return localStorage.getItem(STORAGE) || ''; } catch (_) { return ''; } }
  function save(k) { try { localStorage.setItem(STORAGE, String(k).trim().replace(/\s+/g, '')); } catch (_) { /* ignore */ } }

  /** 保存済みキーの現在の状態 */
  async function status() {
    const k = stored();
    if (!k) return { active: false, key: '' };
    const r = await verify(k);
    return Object.assign({ active: r.ok, key: k }, r);
  }
  async function activate(keyStr) {
    const r = await verify(keyStr);
    if (r.ok) save(keyStr);
    return r;
  }
  function deactivate() { try { localStorage.removeItem(STORAGE); } catch (_) { /* ignore */ } }

  // ------------------------------------------------------------
  // 自動更新（月払い向け）
  //   期限が近いキーを、ライセンスIDだけを送って新しいものに差し替える。
  //   送るのは英数字のライセンスIDだけで、振込データは一切送らない。
  //   config.js の LICENSE_API が空なら何もしない（＝完全オフライン動作のまま）。
  // ------------------------------------------------------------
  const REFRESH_WITHIN_DAYS = 10;
  function daysUntil(ymd) {
    const t = new Date(ymd + 'T00:00:00').getTime() - new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00').getTime();
    return Math.round(t / 86400000);
  }

  /**
   * 必要なら更新する。
   * @returns {Promise<{refreshed:boolean, expiry?:string, reason?:string}>}
   */
  async function refreshIfNeeded(force) {
    const api = ((typeof window !== 'undefined' && window.ZENGIN_CONFIG) || {}).LICENSE_API;
    if (!api) return { refreshed: false, reason: 'no-api' };
    const cur = await status();
    // 期限切れでも payload は読めているので、その id で復帰を試みる
    const id = cur.payload && cur.payload.id;
    if (!id) return { refreshed: false, reason: 'no-key' };
    if (!force && cur.active && daysUntil(cur.expiry) > REFRESH_WITHIN_DAYS) return { refreshed: false, reason: 'not-due' };
    try {
      const res = await fetch(`${api}?id=${encodeURIComponent(id)}`, { method: 'GET', cache: 'no-store' });
      if (!res.ok) return { refreshed: false, reason: `http-${res.status}` };
      const j = await res.json();
      if (!j || !j.key) return { refreshed: false, reason: 'bad-response' };
      const v = await verify(j.key);
      if (!v.ok) return { refreshed: false, reason: v.reason };
      if (v.expiry === cur.expiry) return { refreshed: false, reason: 'unchanged', expiry: v.expiry };
      save(j.key);
      return { refreshed: true, expiry: v.expiry };
    } catch (e) {
      return { refreshed: false, reason: 'offline' };
    }
  }

  return { verify, status, activate, deactivate, refreshIfNeeded, STORAGE, PUBLIC_KEY };
});
