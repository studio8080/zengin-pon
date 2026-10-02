/* app.js — 画面まわり（4ステップのウィザード）。
 * 変換ロジックは zengin.js、表の自動整理は organize.js、金融機関辞書は dict.js、
 * スプレッドシート連携は gsheets.js、休業日は holidays.js、Pro判定は license.js。 */
(function () {
  'use strict';
  const Z = window.Zengin, O = window.Organize, D = window.BankDict, G = window.GSheets, L = window.License;
  const $ = (id) => document.getElementById(id);
  const FIELDS = O.FIELDS;
  const FREE_LIMIT = 20;
  const KEYS = { settings: 'zenginpon.settings', profiles: 'zenginpon.profiles', history: 'zenginpon.history', historyOn: 'zenginpon.historyOn', mapPrefix: 'zenginpon.map.' };

  // ------------------------------------------------------------
  // 状態
  // ------------------------------------------------------------
  const state = {
    step: 1, sheets: {}, sheetNames: [], sheetName: '', raw: [], table: [], headerIdx: 0, forcedHeaderIdx: null,
    mapping: {}, info: {}, notes: [], rows: [], fileName: '', excluded: new Set(), fileLoaded: false,
    pro: false, proExpiry: '', sessionMaps: {},
  };
  let lastBytes = null, lastName = '', lastMeta = null;

  const SETTING_IDS = ['clientCode', 'clientName', 'date', 'bankCode', 'branchCode', 'depositType', 'accountNo', 'bankName', 'branchName', 'newline', 'ext', 'smallToLarge', 'transferType', 'fillNames'];
  const PROFILE_IDS = ['clientCode', 'clientName', 'bankCode', 'branchCode', 'depositType', 'accountNo', 'bankName', 'branchName', 'newline', 'ext', 'smallToLarge', 'transferType', 'fillNames'];

  const ls = {
    get(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : v; } catch (_) { return def; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } },
    json(k, def) { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? def; } catch (_) { return def; } },
    keys() { try { return Object.keys(localStorage).filter((k) => k.startsWith('zenginpon.')); } catch (_) { return []; } },
  };

  function loadSettings() {
    const s = ls.json(KEYS.settings, {});
    for (const id of SETTING_IDS) if (s[id] != null) $(id).value = s[id];
    const kind = s.kind || '21';
    document.querySelectorAll('input[name="kindRadio"]').forEach((r) => { r.checked = r.value === kind; });
    if (!$('date').value) { const d = new Date(); d.setDate(d.getDate() + 1); $('date').value = d.toISOString().slice(0, 10); }
  }
  function saveSettings() {
    const s = { kind: currentKind() };
    // サンプル用に入れた仮の値（data-demo）は保存しない
    for (const id of SETTING_IDS) s[id] = $(id).dataset.demo === '1' ? '' : $(id).value;
    ls.set(KEYS.settings, JSON.stringify(s));
  }

  // サンプルを試すとき、振込元が未入力だと最後まで進めないので、空欄にだけ仮の値を入れる
  const DEMO = { clientCode: '1234567890', clientName: '株式会社サンプルショウジ', bankCode: '0005', branchCode: '001', accountNo: '1234567' };
  function fillDemo() {
    let filled = false;
    for (const [id, v] of Object.entries(DEMO)) { const el = $(id); if (!el.value) { el.value = v; el.dataset.demo = '1'; filled = true; } }
    $('demoNote').hidden = !filled && !document.querySelector('[data-demo="1"]');
  }
  function clearDemo() {
    for (const id of Object.keys(DEMO)) { const el = $(id); if (el.dataset.demo === '1') { el.value = ''; delete el.dataset.demo; } }
    $('demoNote').hidden = true;
  }
  function currentKind() { const r = document.querySelector('input[name="kindRadio"]:checked'); return r ? r.value : '21'; }
  function convOpts() { return { smallToLarge: $('smallToLarge').value === '1', defaultTransferType: $('transferType').value }; }

  // ------------------------------------------------------------
  // Pro（ライセンス）
  // ------------------------------------------------------------
  async function refreshPro(opts) {
    // 月払いの更新: 期限が近い（または切れた）キーを、ライセンスIDだけ送って自動で取り直す。
    // config.js の LICENSE_API が空なら何も起きない。オフラインでも黙って諦める。
    if (opts && opts.tryRefresh) {
      try { await L.refreshIfNeeded(opts.force); } catch (_) { /* ignore */ }
    }
    const st = await L.status();
    state.pro = !!st.active; state.proExpiry = st.expiry || '';
    $('proBtn').textContent = state.pro ? `⭐ Pro 有効（〜${st.expiry}）` : '⭐ Pro';
    $('proBtn').classList.toggle('on', state.pro);
    $('profileBar').hidden = !state.pro;
    $('historyBox').hidden = !state.pro;
    $('historyOn').disabled = !state.pro; $('backupBtn').disabled = !state.pro; $('restoreFile').disabled = !state.pro;
    if (state.pro) renderProfiles();
    renderHistory();
    // ダイアログ内の表示
    const box = $('proStatus');
    if (state.pro) box.innerHTML = `<span class="tag ok">有効</span> 有効期限 <b>${esc(st.expiry)}</b> まで。件数無制限・テンプレート保存・プロファイル・履歴・バックアップが使えます。`;
    else if (st.key) box.innerHTML = `<span class="tag ng">無効</span> ${esc(st.reason || '')}`;
    else box.innerHTML = `<span class="tag">Free</span> 1回 ${FREE_LIMIT} 件まで。Proにすると件数無制限になり、列の割り当てを次回から自動復元します。`;
    $('proDeactivate').hidden = !st.key;
    $('proRefresh').hidden = !(st.key && (window.ZENGIN_CONFIG || {}).LICENSE_API);
    if (state.step === 4) renderPreview();
    if (state.step === 2 && state.fileLoaded) renderMapping();
  }
  $('proBtn').addEventListener('click', () => { $('proKey').value = ''; $('proMsg').textContent = ''; $('proDialog').showModal(); });
  $('proActivate').addEventListener('click', async () => {
    const r = await L.activate($('proKey').value);
    $('proMsg').textContent = r.ok ? `✔ 有効になりました（〜${r.expiry}）` : `✖ ${r.reason}`;
    $('proMsg').style.color = r.ok ? 'var(--ok)' : 'var(--ng)';
    await refreshPro();
  });
  $('proRefresh').addEventListener('click', async () => {
    $('proMsg').textContent = '確認中…'; $('proMsg').style.color = '';
    const r = await L.refreshIfNeeded(true);
    const msg = { 'no-api': '自動更新は設定されていません', 'no-key': 'キーが入っていません', unchanged: '最新の状態です', offline: 'サーバーに接続できませんでした', 'http-404': 'このライセンスが見つかりません（お問い合わせください）', 'not-entitled': 'ご契約が終了しているため、Proを解除しました' };
    $('proMsg').textContent = r.refreshed ? `✔ 更新しました（〜${r.expiry}）` : (msg[r.reason] || `更新できませんでした（${r.reason}）`);
    $('proMsg').style.color = r.refreshed ? 'var(--ok)' : '';
    await refreshPro();
  });
  $('proDeactivate').addEventListener('click', async () => { L.deactivate(); $('proMsg').textContent = 'このブラウザのキーを削除しました'; await refreshPro(); });
  $('settingsBtn').addEventListener('click', () => { $('historyOn').checked = ls.get(KEYS.historyOn, '0') === '1'; $('settingsDialog').showModal(); });
  $('historyOn').addEventListener('change', () => ls.set(KEYS.historyOn, $('historyOn').checked ? '1' : '0'));

  // バックアップ・復元・削除
  $('backupBtn').addEventListener('click', () => {
    const data = {}; for (const k of ls.keys()) data[k] = ls.get(k, '');
    const blob = new Blob([JSON.stringify({ app: 'zenginpon', exported: new Date().toISOString(), data }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `zenginpon-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
  });
  $('restoreFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (j.app !== 'zenginpon' || !j.data) throw new Error('全銀ポンのバックアップファイルではありません');
      for (const [k, v] of Object.entries(j.data)) if (k.startsWith('zenginpon.')) ls.set(k, String(v));
      alert('読み込みました。ページを再読み込みします。'); location.reload();
    } catch (err) { alert(`読み込めませんでした: ${err.message}`); }
    e.target.value = '';
  });
  $('clearBtn').addEventListener('click', () => {
    if (!confirm('このブラウザに保存された全銀ポンの設定（振込元・プロファイル・列の割り当て・履歴・ライセンスキー）をすべて削除します。よろしいですか？')) return;
    for (const k of ls.keys()) ls.del(k);
    location.reload();
  });

  // ------------------------------------------------------------
  // 振込元プロファイル（Pro）
  // ------------------------------------------------------------
  function profiles() { return ls.json(KEYS.profiles, []); }
  function renderProfiles(selectedName) {
    const sel = $('profileSel');
    const list = profiles();
    sel.innerHTML = '<option value="">（現在の入力）</option>' + list.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
    if (selectedName) sel.value = selectedName;
    $('profileDelete').hidden = !sel.value;
  }
  $('profileSel').addEventListener('change', () => {
    const p = profiles().find((x) => x.name === $('profileSel').value);
    $('profileDelete').hidden = !p;
    if (!p) return;
    for (const id of PROFILE_IDS) if (p.values[id] != null) $(id).value = p.values[id];
    $('profileName').value = p.name;
    saveSettings(); updateHeaderPreviews();
  });
  $('profileSave').addEventListener('click', () => {
    const name = $('profileName').value.trim() || Z.toZenginChars($('clientName').value) || '';
    if (!name) { alert('プロファイル名を入力してください'); return; }
    const values = {}; for (const id of PROFILE_IDS) values[id] = $(id).value;
    const list = profiles().filter((x) => x.name !== name); list.push({ name, values });
    ls.set(KEYS.profiles, JSON.stringify(list));
    renderProfiles(name);
  });
  $('profileDelete').addEventListener('click', () => {
    const name = $('profileSel').value; if (!name || !confirm(`プロファイル「${name}」を削除しますか？`)) return;
    ls.set(KEYS.profiles, JSON.stringify(profiles().filter((x) => x.name !== name)));
    renderProfiles('');
  });

  // ------------------------------------------------------------
  // ステップ遷移
  // ------------------------------------------------------------
  function goStep(n) {
    if (n >= 2 && !state.fileLoaded) return;
    if (n >= 3 && !mappingComplete()) return;
    state.step = n;
    for (let i = 1; i <= 4; i++) $(`panel${i}`).hidden = i !== n;
    document.querySelectorAll('.stepper .step').forEach((el) => {
      const s = Number(el.dataset.step);
      el.classList.toggle('is-active', s === n);
      el.classList.toggle('is-done', s < n);
      if (s === n) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
      el.disabled = !(s < n); // 戻れるのは済んだ手順だけ。進むのは各画面の「次へ」から
    });
    document.querySelectorAll('.stepper .bar').forEach((el, i) => el.classList.toggle('is-done', i + 1 < n));
    if (n === 3) updateHeaderPreviews();
    if (n === 4) rebuildRows();
    $('tool').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => goStep(Number(b.dataset.go))));
  document.querySelectorAll('.stepper .step').forEach((b) => b.addEventListener('click', () => { if (b.classList.contains('is-done')) goStep(Number(b.dataset.step)); }));

  // ------------------------------------------------------------
  // Step 1: ファイル読込（ローカル／Googleスプレッドシート）
  // ------------------------------------------------------------
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
  // キーボードだけでもファイルを選べるようにする（Enter / Space でファイル選択を開く）
  drop.addEventListener('keydown', (e) => {
    if (e.target !== drop) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); }
  });

  // はじめての人向け: サンプルデータをその場で読み込む（ダウンロードして選び直す手間をなくす）
  document.querySelectorAll('[data-sample]').forEach((b) => b.addEventListener('click', async () => {
    const info = $('fileInfo');
    try {
      const kind = b.dataset.kind;
      if (kind) { document.querySelectorAll('input[name="kindRadio"]').forEach((r) => { r.checked = r.value === kind; }); saveSettings(); }
      const res = await fetch(b.dataset.sample);
      if (!res.ok) throw new Error('サンプルを読み込めませんでした');
      const buf = await res.arrayBuffer();
      state.isSample = true;
      fillDemo();
      await handleBuffer(b.dataset.sample.split('/').pop(), buf, buf.byteLength);
      info.textContent += '（架空のサンプルデータです）';
    } catch (e) { info.hidden = false; info.className = 'fileinfo err'; info.textContent = e.message; }
  }));
  $('file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) handleFile(f); e.target.value = ''; });
  document.querySelectorAll('input[name="kindRadio"]').forEach((r) => r.addEventListener('change', () => { saveSettings(); if (state.fileLoaded) analyzeSheet(); }));

  $('gsheetBtn').addEventListener('click', async () => {
    const info = $('fileInfo');
    if (!G.configured()) {
      info.hidden = false; info.className = 'fileinfo err';
      info.textContent = 'Googleスプレッドシート連携はまだ有効になっていません。いまは「ファイル→ダウンロード→Microsoft Excel」で保存したファイルを読み込んでください。';
      return;
    }
    try {
      info.hidden = false; info.className = 'fileinfo'; info.textContent = 'Googleに接続中…';
      const picked = await G.pickSpreadsheet();
      if (!picked) { info.hidden = true; return; }
      await handleBuffer(picked.name, picked.buffer, picked.buffer.byteLength);
    } catch (e) { console.error(e); info.className = 'fileinfo err'; info.textContent = e.message; }
  });

  async function handleFile(file) { state.isSample = false; clearDemo(); await handleBuffer(file.name, await file.arrayBuffer(), file.size); }

  async function handleBuffer(name, buf, size) {
    state.fileName = name;
    const info = $('fileInfo');
    info.hidden = false; info.className = 'fileinfo';
    info.textContent = `読み込み中… ${name}`;
    try {
      const ext = (name.split('.').pop() || '').toLowerCase();
      if (ext === 'pdf') { state.sheetNames = ['PDF']; state.sheets = { PDF: await extractPdfTable(buf) }; }
      else if (ext === 'csv' || ext === 'txt') setWorkbook(XLSX.read(decodeText(buf), { type: 'string', raw: true }));
      else setWorkbook(XLSX.read(buf, { type: 'array', raw: true, cellDates: false }));
      state.fileLoaded = true; state.excluded = new Set(); state.rows = []; state.forcedHeaderIdx = null;
      info.textContent = `✔ ${name}（${(size / 1024).toFixed(1)} KB）を読み込みました`;
      $('sheet').innerHTML = state.sheetNames.map((n) => `<option>${esc(n)}</option>`).join('');
      state.sheetName = state.sheetNames[0];
      analyzeSheet();
      goStep(2);
    } catch (e) { console.error(e); info.className = 'fileinfo err'; info.textContent = `読み込みに失敗しました: ${e.message}`; }
  }

  function decodeText(buf) {
    const u8 = new Uint8Array(buf);
    // Excel の「Unicode テキスト」保存は UTF-16（BOM つき）。BOM で判定し、無ければ UTF-8 → Shift_JIS の順に試す
    if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8);
    if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch (_) { return new TextDecoder('shift_jis').decode(u8); }
  }
  function setWorkbook(wb) {
    state.sheetNames = wb.SheetNames; state.sheets = {};
    for (const n of wb.SheetNames) state.sheets[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' });
  }
  $('sheet').addEventListener('change', () => { state.sheetName = $('sheet').value; state.forcedHeaderIdx = null; analyzeSheet(); });
  $('headerRow').addEventListener('change', () => { state.forcedHeaderIdx = Number($('headerRow').value); analyzeSheet(); });

  // ------------------------------------------------------------
  // Step 2: 自動整理と列の割り当て
  // ------------------------------------------------------------
  function headerSignature(headers) { return KEYS.mapPrefix + headers.map(O.normHeader).join('|').slice(0, 400); }
  function loadMapping(sig) { return state.pro ? ls.json(sig, null) : (state.sessionMaps[sig] || null); }
  function storeMapping(sig, mapping) { if (state.pro) ls.set(sig, JSON.stringify(mapping)); else state.sessionMaps[sig] = mapping; }

  function analyzeSheet() {
    const raw = (state.sheets[state.sheetName] || []).map((r) => r.map((c) => (c == null ? '' : String(c).trim())));
    state.raw = raw;
    const a = O.analyze(raw, currentKind(), state.forcedHeaderIdx);
    state.table = a.table; state.headerIdx = a.headerIdx; state.info = a.info; state.notes = a.notes;
    const headers = state.table[state.headerIdx] || [];
    const saved = loadMapping(headerSignature(headers));
    if (saved) { state.mapping = saved; state.info = {}; for (const k of Object.keys(saved)) state.info[k] = { method: 'saved', reason: '前回の設定' }; }
    else state.mapping = a.mapping;
    const hs = $('headerRow');
    hs.innerHTML = raw.slice(0, 30).map((r, i) => `<option value="${i}">${i + 1}行目: ${esc(r.filter(Boolean).slice(0, 5).join(' | ')).slice(0, 60)}</option>`).join('');
    hs.value = String(a.hasHeader ? state.headerIdx : (state.forcedHeaderIdx != null ? state.forcedHeaderIdx : 0));
    renderMapping();
  }

  function dataRows() { return state.table.slice(state.headerIdx + 1).filter((r) => r.some((c) => c !== '')); }
  function mappingComplete() {
    const m = state.mapping;
    const yucho = m.yuchoKigo != null && m.yuchoBango != null;
    const hasBank = m.bankCode != null || m.bankName != null || yucho;
    const hasBranch = m.branchCode != null || m.branchName != null || yucho;
    const hasAcct = m.accountNo != null || yucho;
    return hasBank && hasBranch && hasAcct && m.name != null && m.amount != null;
  }

  function renderMapping() {
    const headers = state.table[state.headerIdx] || [];
    const kind = currentKind();
    const example = dataRows()[0] || [];
    const tbl = $('mapping');
    let html = '<thead><tr><th>全銀フォーマットの項目</th><th>あなたのファイルの列</th><th>根拠</th><th>例（1行目の値）</th></tr></thead><tbody>';
    for (const f of FIELDS) {
      if (f.kinds && !f.kinds.includes(kind)) continue;
      const v = state.mapping[f.key] != null ? String(state.mapping[f.key]) : '';
      const inf = state.info[f.key];
      let basis = '';
      if (v !== '' && inf) {
        if (inf.method === 'inferred') basis = `<span class="tag infer">推定</span> <span class="sub">${esc(inf.reason)}</span>`;
        else if (inf.method === 'saved') basis = '<span class="tag ok">前回</span>';
        else basis = `<span class="sub">${esc(inf.reason)}</span>`;
      }
      let req = f.required;
      if (f.key === 'bankCode' && state.mapping.bankName != null) req = false;
      if (f.key === 'branchCode' && state.mapping.branchName != null) req = false;
      html += `<tr class="${f.required ? '' : 'optional'}"><td class="field">${esc(f.label)}${f.required ? '<span class="req">*</span>' : ''}</td>`
        + `<td><select data-key="${f.key}" class="${req && v === '' ? 'unset' : ''}"><option value="">（使わない）</option>`
        + headers.map((h, i) => `<option value="${i}" ${String(i) === v ? 'selected' : ''}>${esc(h || `列${i + 1}`)}</option>`).join('')
        + `</select></td><td>${basis}${(f.key === 'bankCode' && v === '' && state.mapping.bankName != null) ? '<span class="sub">銀行名から辞書で補います</span>' : ''}${(f.key === 'branchCode' && v === '' && state.mapping.branchName != null) ? '<span class="sub">支店名から辞書で補います</span>' : ''}</td>`
        + `<td class="ex">${v === '' ? '' : esc(example[Number(v)] || '')}</td></tr>`;
    }
    tbl.innerHTML = html + '</tbody>';
    tbl.querySelectorAll('select').forEach((sel) => sel.addEventListener('change', () => {
      const key = sel.dataset.key;
      if (sel.value === '') delete state.mapping[key]; else { state.mapping[key] = Number(sel.value); state.info[key] = { method: 'header', reason: '手動で選択' }; }
      storeMapping(headerSignature(headers), state.mapping);
      renderMapping();
    }));
    const notes = $('organizeNotes');
    const extra = state.pro ? [] : ['列の割り当てを次回から自動で復元するには Pro が必要です（この画面で直した内容は、ページを閉じるまで有効です）'];
    const all = state.notes.concat(extra);
    notes.hidden = !all.length;
    notes.innerHTML = all.map((n) => `<div>🧹 ${esc(n)}</div>`).join('');
    const rows = dataRows();
    const totals = rows.filter((r) => O.isTotalRow(r, state.mapping)).length;
    const heads = rows.filter((r) => !O.isTotalRow(r, state.mapping) && O.isRepeatedHeader(r, state.table[state.headerIdx])).length;
    const skipped = [totals && `合計行 ${totals} 行`, heads && `途中の見出し ${heads} 行`].filter(Boolean).join('・');
    $('rowCount').textContent = `${rows.length - totals - heads} 行を認識${skipped ? `（${skipped}を除外）` : ''}`;
    $('toStep3').disabled = !mappingComplete();
  }

  // ------------------------------------------------------------
  // Step 3: 振込元情報のプレビュー
  // ------------------------------------------------------------
  function dateWarning() {
    const s = $('date').value;
    const reason = window.Holidays ? Holidays.bankHolidayReason(s) : null;
    if (!reason) return '';
    return `振込指定日 ${s} は${reason}で銀行休業日です。次の営業日は ${Holidays.nextBusinessDay(s)} です`;
  }
  async function updateHeaderPreviews() {
    $('clientNamePreview').textContent = Z.toZenginChars($('clientName').value);
    const dw = dateWarning();
    $('datePreview').textContent = dw || '';
    $('datePreview').className = dw ? 'preview warn' : 'preview';
    await D.load().catch(() => null);
    const bc = $('bankCode').value.replace(/\D/g, '').padStart(4, '0').slice(-4);
    const b = D.bank(bc);
    const bp = $('bankCodeName');
    if (!$('bankCode').value) { bp.textContent = ''; bp.className = 'preview'; }
    else if (b) { bp.textContent = b[0] + '銀行'; bp.className = 'preview'; }
    else { bp.textContent = '金融機関一覧にないコードです'; bp.className = 'preview ng'; }
    const brp = $('branchCodeName');
    const brc = $('branchCode').value.replace(/\D/g, '').padStart(3, '0').slice(-3);
    if (b && $('branchCode').value) {
      await D.branches(bc);
      const br = D.branch(bc, brc);
      if (br) { brp.textContent = /[店部所]$/.test(br[0]) ? br[0] : br[0] + '支店'; brp.className = 'preview'; }
      else { brp.textContent = 'この銀行の支店一覧にないコードです'; brp.className = 'preview ng'; }
    } else { brp.textContent = ''; brp.className = 'preview'; }
  }
  for (const id of SETTING_IDS) {
    $(id).addEventListener('input', () => { delete $(id).dataset.demo; saveSettings(); if (state.step === 3) updateHeaderPreviews(); });
    $(id).addEventListener('change', () => { saveSettings(); if (state.step === 3) updateHeaderPreviews(); });
  }

  // ------------------------------------------------------------
  // Step 4: 行の組み立て・辞書照合・検証・プレビュー
  // ------------------------------------------------------------
  async function rebuildRows() {
    const m = state.mapping, opts = convOpts();
    const rows = [];
    state.table.slice(state.headerIdx + 1).forEach((r, i) => {
      if (!r.some((c) => c !== '')) return;
      if (O.isTotalRow(r, m)) return;
      if (O.isRepeatedHeader(r, state.table[state.headerIdx])) return;   // 改ページで繰り返された見出し
      const raw = {};
      for (const f of FIELDS) raw[f.key] = m[f.key] != null ? r[m[f.key]] : '';
      if (!raw.amount && !raw.accountNo && !raw.name) return;
      const n = Z.normalizeRow(raw, opts);
      n._src = state.headerIdx + 2 + i;
      n._rawName = raw.name; n._rawBankName = raw.bankName; n._rawBranchName = raw.branchName;
      n._warn = []; n._info = [];
      rows.push(n);
    });
    const prev = new Map(state.rows.map((r) => [r._src, r]));
    for (const r of rows) { const p = prev.get(r._src); if (p && p._edited) { r.name = p.name; r._edited = true; } }
    state.rows = rows;

    let dictOk = false;
    try { await D.load(); dictOk = true; } catch (_) { dictOk = false; }
    if (dictOk) {
      // 銀行名・支店名の欄にコードだけが書かれている（「0005」「001」「店番123」）ときは、コードとして使う
      for (const r of rows) {
        const bn = String(r._rawBankName || '').normalize('NFKC').trim(), sn = String(r._rawBranchName || '').normalize('NFKC').replace(/^店番|^支店コード|^支店番号/, '').trim();
        if (!r.bankCode && /^\d{1,4}$/.test(bn)) { r.bankCode = bn.padStart(4, '0'); r._rawBankName = ''; }
        if (!r.branchCode && /^\d{1,3}$/.test(sn)) { r.branchCode = sn.padStart(3, '0'); r._rawBranchName = ''; }
      }
      for (const r of rows) {
        if (r.bankCode || !r._rawBankName) continue;
        const c = D.findBank(r._rawBankName);
        const exact = c.filter((x) => x.exact);
        if (exact.length === 1 || (exact.length === 0 && c.length === 1)) {
          const hit = exact[0] || c[0]; r.bankCode = hit.code;
          r._info.push(`銀行名「${r._rawBankName}」から銀行コード ${hit.code}（${hit.name}）を補いました`);
        } else if (c.length > 1) r._warn.push(`銀行名「${r._rawBankName}」に候補が複数あります: ${c.slice(0, 4).map((x) => `${x.code} ${x.name}`).join(' / ')}`);
        else r._warn.push(`銀行名「${r._rawBankName}」が金融機関一覧に見つかりません`);
      }
      const codes = [...new Set(rows.map((r) => r.bankCode).filter(Boolean))];
      await Promise.all(codes.map((c) => D.branches(c)));
      for (const r of rows) {
        if (r.branchCode || !r._rawBranchName || !r.bankCode) continue;
        const c = D.findBranch(r.bankCode, r._rawBranchName);
        const exact = c.filter((x) => x.exact);
        if (exact.length === 1 || (exact.length === 0 && c.length === 1)) {
          const hit = exact[0] || c[0]; r.branchCode = hit.code;
          r._info.push(`支店名「${r._rawBranchName}」から支店コード ${hit.code}（${hit.name}）を補いました`);
        } else if (c.length > 1) r._warn.push(`支店名「${r._rawBranchName}」に候補が複数あります: ${c.slice(0, 4).map((x) => `${x.code} ${x.name}`).join(' / ')}`);
        else r._warn.push(`支店名「${r._rawBranchName}」がこの銀行の支店一覧に見つかりません`);
      }
      const fill = $('fillNames').value === '1';
      for (const r of rows) {
        if (!fill) { r.bankName = ''; r.branchName = ''; }   // 「空欄で出力する」を選んだら表の値も使わない
        const b = D.bank(r.bankCode);
        const merged = D.mergedInfo(r.bankCode);
        if (merged) r._warn.push(`銀行コード ${r.bankCode} は ${merged.name}（${merged.date}）で新コード ${merged.new} に変わっています。${merged.branchNote || ''}`);
        else if (!b) { if (r.bankCode) r._warn.push(`銀行コード ${r.bankCode} は金融機関一覧（${D.version}版）にありません。統廃合か入力ミスの可能性があります`); }
        else {
          r._dictBank = b[0];
          // 辞書にある銀行は、表に書かれた名前（旧名・略称・コードなど）より辞書の正式なカナを使う
          if (fill) r.bankName = Z.toZenginChars(b[1], { abbreviateCorp: false }).slice(0, 15);
          const br = D.branch(r.bankCode, r.branchCode);
          if (br) { r._dictBranch = br[0]; if (fill) r.branchName = Z.toZenginChars(br[1], { abbreviateCorp: false }).slice(0, 15); }
          else if (/^\d+$/.test(r.branchName || '')) r.branchName = '';   // 支店名の欄にコードが書かれていた場合
          else if (br === null && r.branchCode) r._warn.push(`支店コード ${r.branchCode} は ${b[0]}の支店一覧にありません`);
        }
      }
    }
    renderPreview();
  }

  /** 出力対象（除外・無料上限を反映） */
  function targetRows() {
    const inc = state.rows.filter((r) => !state.excluded.has(r._src));
    return state.pro ? inc : inc.slice(0, FREE_LIMIT);
  }

  function renderPreview() {
    const kind = currentKind();
    const tbl = $('preview');
    const cols = ['状態', '行', '銀行', '支店', '種目', '口座番号', '受取人名（半角カナ）', '金額'];
    if (kind === '21') cols.push('顧客コード'); else cols.push('社員番号', '所属');
    cols.push('メッセージ');
    let html = '<thead><tr><th></th>' + cols.map((c) => `<th class="${c === '金額' ? 'r' : ''}">${c}</th>`).join('') + '</tr></thead><tbody>';
    let okCount = 0, ngCount = 0, warnCount = 0, total = 0, overLimit = 0, seen = 0;
    state.rows.forEach((r, i) => {
      const errs = Z.validateRow(r, kind);
      const warns = r._warn || [], infos = r._info || [];
      const skipped = state.excluded.has(r._src);
      let limited = false;
      if (!skipped) { seen++; if (!state.pro && seen > FREE_LIMIT) { limited = true; overLimit++; } }
      if (!skipped && !limited) { if (errs.length) ngCount++; else { okCount++; total += r.amount; if (warns.length) warnCount++; } }
      const dep = { 1: '普通', 2: '当座', 4: '貯蓄', 9: 'その他' }[r.depositType] || r.depositType;
      const status = skipped ? '<span class="tag">除外</span>' : limited ? '<span class="tag warn">Free上限外</span>' : errs.length ? '<span class="tag ng">エラー</span>' : warns.length ? '<span class="tag warn">確認</span>' : '<span class="tag ok">OK</span>';
      html += `<tr class="${skipped || limited ? 'skip' : errs.length ? 'bad' : warns.length ? 'warn' : ''}" data-i="${i}">`
        + `<td><input type="checkbox" class="inc" ${skipped ? '' : 'checked'} title="この行を含める"></td><td>${status}</td><td>${r._src}</td>`
        + `<td>${esc(r.bankCode)}${r._dictBank ? `<br><span class="sub">${esc(r._dictBank)}</span>` : ''}</td>`
        + `<td>${esc(r.branchCode)}${r._dictBranch ? `<br><span class="sub">${esc(r._dictBranch)}</span>` : ''}</td>`
        + `<td>${dep}</td><td>${esc(r.accountNo)}</td>`
        + `<td><input class="name" value="${esc(r.name)}" maxlength="30" title="元の値: ${esc(r._rawName)}"></td>`
        + `<td class="r">${Number.isFinite(r.amount) ? r.amount.toLocaleString() : esc(String(r.amount))}</td>`;
      if (kind === '21') html += `<td>${esc(r.customerCode1)}${r.customerCode2 ? '/' + esc(r.customerCode2) : ''}</td>`;
      else html += `<td>${esc(r.employeeNo)}</td><td>${esc(r.deptCode)}</td>`;
      html += `<td>${errs.map((e) => `<span class="msg ng">${esc(e)}</span>`).join('')}${warns.map((w) => `<span class="msg warn">${esc(w)}</span>`).join('')}${infos.map((w) => `<span class="msg info">${esc(w)}</span>`).join('')}</td></tr>`;
    });
    tbl.innerHTML = html + '</tbody>';
    tbl.querySelectorAll('input.name').forEach((inp) => inp.addEventListener('change', () => {
      const r = state.rows[Number(inp.closest('tr').dataset.i)];
      r.name = Z.toZenginChars(inp.value, Object.assign({ abbreviateCorp: false }, convOpts()));
      r._edited = true; renderPreview();
    }));
    tbl.querySelectorAll('input.inc').forEach((inp) => inp.addEventListener('change', () => {
      const r = state.rows[Number(inp.closest('tr').dataset.i)];
      if (inp.checked) state.excluded.delete(r._src); else state.excluded.add(r._src);
      renderPreview();
    }));
    $('summary').innerHTML = `<div><small>振込件数</small><b>${okCount + ngCount}</b> 件</div>`
      + `<div class="ok"><small>OK</small><b>${okCount}</b> 件</div>`
      + `<div class="${warnCount ? 'warn' : ''}"><small>要確認</small><b>${warnCount}</b> 件</div>`
      + `<div class="${ngCount ? 'ng' : ''}"><small>エラー</small><b>${ngCount}</b> 件</div>`
      + `<div><small>合計金額</small><b>¥${total.toLocaleString()}</b></div>`;
    const fl = $('freeLimit');
    fl.hidden = !overLimit;
    fl.innerHTML = overLimit ? `無料プランは1回 ${FREE_LIMIT} 件までです。<b>${overLimit} 件</b>が出力対象外になっています（表の「Free上限外」）。Proにすると件数無制限になります。 <button type="button" class="btn mini" id="freeLimitPro">⭐ Proのキーを入力</button> <a class="btn mini" href="pricing.html">料金を見る</a>` : '';
    if (overLimit) $('freeLimitPro').addEventListener('click', () => $('proBtn').click());
    generate(ngCount === 0 && okCount > 0);
  }

  // ------------------------------------------------------------
  // 生成・ダウンロード・履歴
  // ------------------------------------------------------------
  function readHeader() {
    const d = $('date').value;
    return {
      kind: currentKind(), clientCode: $('clientCode').value, clientName: Z.toZenginChars($('clientName').value),
      date: d ? d.slice(5, 7) + d.slice(8, 10) : '',
      bankCode: $('bankCode').value, bankName: Z.toZenginChars($('bankName').value, { abbreviateCorp: false }),
      branchCode: $('branchCode').value, branchName: Z.toZenginChars($('branchName').value, { abbreviateCorp: false }),
      depositType: $('depositType').value, accountNo: $('accountNo').value,
    };
  }

  function generate(rowsOk) {
    const h = readHeader();
    const hErrs = Z.validateHeader(h);
    const btn = $('download');
    const rows = targetRows();
    const he = $('headerErrors');
    he.hidden = !hErrs.length;
    he.innerHTML = hErrs.length ? `振込元の情報を確認してください: ${esc(hErrs.join(' / '))} <button class="btn mini" data-go="3" style="margin-left:8px">直す</button>` : '';
    he.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => goStep(3)));
    const dw = dateWarning();
    $('dateWarn').hidden = !dw;
    $('dateWarn').textContent = dw ? `📅 ${dw}。このままでも出力できますが、銀行側で受け付けられない場合があります。` : '';
    if (hErrs.length || !rowsOk || rows.length === 0) {
      btn.disabled = true; lastBytes = null;
      $('downloadName').textContent = rows.length === 0 ? '対象行がありません' : (hErrs.length ? '' : 'エラーの行を直すとダウンロードできます');
      $('out').textContent = ''; $('ruler').textContent = '';
      return;
    }
    try {
      const out = Z.build(h, rows, { newline: $('newline').value });
      lastBytes = Z.encode(out.text);
      lastName = `${Z.KIND_LABEL[h.kind]}_${$('date').value.replace(/-/g, '')}.${$('ext').value}`;
      lastMeta = { kind: Z.KIND_LABEL[h.kind], count: out.count, total: out.total, file: state.fileName, date: $('date').value };
      btn.disabled = false;
      $('downloadName').textContent = `${lastName}（${lastBytes.length.toLocaleString()} バイト・${out.count} 件・¥${out.total.toLocaleString()}）`;
      $('ruler').textContent = '         1         2         3         4         5         6         7         8         9        10        11        12\n123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890';
      $('out').textContent = out.records.join('\n');
    } catch (e) { btn.disabled = true; lastBytes = null; $('downloadName').textContent = `生成エラー: ${e.message}`; }
  }

  function saveBlob(bytes, name) {
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  $('download').addEventListener('click', () => {
    if (!lastBytes) return;
    saveBlob(lastBytes, lastName);
    if (state.pro && ls.get(KEYS.historyOn, '0') === '1') {
      const list = ls.json(KEYS.history, []);
      list.unshift({ ts: new Date().toISOString(), name: lastName, meta: lastMeta, data: bytesToB64(lastBytes) });
      ls.set(KEYS.history, JSON.stringify(list.slice(0, 20)));
      renderHistory();
    }
  });
  function bytesToB64(u8) { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); }
  function b64ToBytes(s) { const bin = atob(s); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; }
  function renderHistory() {
    const box = $('historyList');
    const list = state.pro ? ls.json(KEYS.history, []) : [];
    if (!list.length) { box.innerHTML = `<p class="hint">${ls.get(KEYS.historyOn, '0') === '1' ? 'まだ履歴はありません' : '履歴の保存は「⚙ 設定」で有効にできます'}</p>`; return; }
    box.innerHTML = list.map((h, i) => `<div class="hist"><div><b>${esc(h.name)}</b><br><span class="sub">${esc(h.ts.replace('T', ' ').slice(0, 16))} ・ ${esc(h.meta.kind)} ・ ${h.meta.count} 件 ・ ¥${Number(h.meta.total).toLocaleString()} ・ 元: ${esc(h.meta.file || '')}</span></div><div><button type="button" class="btn mini" data-dl="${i}">再ダウンロード</button> <button type="button" class="btn mini" data-rm="${i}">削除</button></div></div>`).join('')
      + '<p><button type="button" class="btn mini" id="histClear">履歴をすべて削除</button></p>';
    box.querySelectorAll('[data-dl]').forEach((b) => b.addEventListener('click', () => { const h = list[Number(b.dataset.dl)]; saveBlob(b64ToBytes(h.data), h.name); }));
    box.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { list.splice(Number(b.dataset.rm), 1); ls.set(KEYS.history, JSON.stringify(list)); renderHistory(); }));
    $('histClear').addEventListener('click', () => { ls.del(KEYS.history); renderHistory(); });
  }

  // ------------------------------------------------------------
  // PDF → 表（テキスト層のあるPDFのみ）
  // ------------------------------------------------------------
  async function extractPdfTable(buf) {
    if (!window.pdfjsLib) throw new Error('PDF ライブラリが読み込めませんでした');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    // 日本語の CID フォント（埋め込みなし）を読むには CMap が要る。cdnjs に無いので自サイトに置いている（vendor/pdfjs/README.md）
    const pdf = await pdfjsLib.getDocument({ data: buf, cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true }).promise;
    const rows = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      const items = tc.items.filter((it) => it.str && it.str.trim()).map((it) => ({ x: it.transform[4], y: it.transform[5], w: it.width, s: it.str }));
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      const lines = [];
      for (const it of items) { const ln = lines.find((l) => Math.abs(l.y - it.y) <= 3); if (ln) ln.items.push(it); else lines.push({ y: it.y, items: [it] }); }
      for (const ln of lines) {
        ln.items.sort((a, b) => a.x - b.x);
        const cells = []; let cur = null;
        for (const it of ln.items) {
          if (cur && it.x - (cur.x + cur.w) < 6) { cur.s += it.s; cur.w = it.x + it.w - cur.x; }
          else { cur = { x: it.x, w: it.w, s: it.s }; cells.push(cur); }
        }
        rows.push(cells.map((c) => c.s.trim()));
      }
    }
    if (!rows.length) throw new Error('PDFからテキストを取り出せませんでした（スキャン画像のPDFは非対応です）');
    return rows;
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ------------------------------------------------------------
  loadSettings();
  refreshPro({ tryRefresh: true });
  if (!G.configured()) {
    $('gsheetHint').textContent = 'Googleスプレッドシートの直接連携は準備中です。いまは「ファイル → ダウンロード → Microsoft Excel」で保存して、上から読み込んでください。';
    $('gsheetBtn').disabled = true;
    $('gsheetBtn').lastChild.textContent = ' Googleスプレッドシート連携（準備中）';
  }
  D.load().then(() => { $('dictInfo').textContent = `金融機関一覧: ${D.version} 版（全銀協の公開情報をもとにしたオープンデータ）。毎月、更新の有無を確認して反映しています。`; })
    .catch(() => { $('dictInfo').textContent = '金融機関一覧を読み込めませんでした（銀行名の表示とコードの照合は行われません）'; });
})();
