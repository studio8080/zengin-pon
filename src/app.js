/* app.js — 画面まわり（4ステップのウィザード）。
 * 変換ロジックは zengin.js、表の自動整理は organize.js、金融機関辞書は dict.js、スプレッドシート連携は gsheets.js。 */
(function () {
  'use strict';
  const Z = window.Zengin, O = window.Organize, D = window.BankDict, G = window.GSheets;
  const $ = (id) => document.getElementById(id);
  const FIELDS = O.FIELDS;

  // ------------------------------------------------------------
  // 状態
  // ------------------------------------------------------------
  const state = {
    step: 1, sheets: {}, sheetNames: [], sheetName: '', raw: [], table: [], headerIdx: 0, forcedHeaderIdx: null,
    mapping: {}, info: {}, notes: [], rows: [], fileName: '', excluded: new Set(), fileLoaded: false,
  };
  let lastBytes = null, lastName = '';

  const SETTING_IDS = ['clientCode', 'clientName', 'date', 'bankCode', 'branchCode', 'depositType', 'accountNo', 'bankName', 'branchName', 'newline', 'ext', 'smallToLarge', 'transferType', 'fillNames'];

  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem('zenginfb.settings') || '{}'); } catch (_) { /* ignore */ }
    for (const id of SETTING_IDS) if (s[id] != null) $(id).value = s[id];
    const kind = s.kind || '21';
    document.querySelectorAll('input[name="kindRadio"]').forEach((r) => { r.checked = r.value === kind; });
    if (!$('date').value) { const d = new Date(); d.setDate(d.getDate() + 1); $('date').value = d.toISOString().slice(0, 10); }
  }
  function saveSettings() {
    const s = { kind: currentKind() };
    for (const id of SETTING_IDS) s[id] = $(id).value;
    try { localStorage.setItem('zenginfb.settings', JSON.stringify(s)); } catch (_) { /* ignore */ }
  }
  function currentKind() { const r = document.querySelector('input[name="kindRadio"]:checked'); return r ? r.value : '21'; }
  function convOpts() { return { smallToLarge: $('smallToLarge').value === '1', defaultTransferType: $('transferType').value }; }

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
    });
    document.querySelectorAll('.stepper .bar').forEach((el, i) => el.classList.toggle('is-done', i + 1 < n));
    if (n === 3) updateHeaderPreviews();
    if (n === 4) rebuildRows();
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
  $('file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) handleFile(f); e.target.value = ''; });
  document.querySelectorAll('input[name="kindRadio"]').forEach((r) => r.addEventListener('change', () => { saveSettings(); if (state.fileLoaded) analyzeSheet(); }));

  $('gsheetBtn').addEventListener('click', async () => {
    const info = $('fileInfo');
    if (!G.configured()) {
      info.hidden = false; info.className = 'fileinfo err';
      info.textContent = 'Googleスプレッドシート連携はまだ有効になっていません（config.js の設定が必要です）。いまは「ファイル→ダウンロード→Excel」で保存したファイルを読み込んでください。';
      return;
    }
    try {
      info.hidden = false; info.className = 'fileinfo'; info.textContent = 'Googleに接続中…';
      const picked = await G.pickSpreadsheet();
      if (!picked) { info.hidden = true; return; }
      await handleBuffer(picked.name, picked.buffer, picked.buffer.byteLength);
    } catch (e) {
      console.error(e);
      info.className = 'fileinfo err'; info.textContent = e.message;
    }
  });

  async function handleFile(file) { await handleBuffer(file.name, await file.arrayBuffer(), file.size); }

  async function handleBuffer(name, buf, size) {
    state.fileName = name;
    const info = $('fileInfo');
    info.hidden = false; info.className = 'fileinfo';
    info.textContent = `読み込み中… ${name}`;
    try {
      const ext = (name.split('.').pop() || '').toLowerCase();
      if (ext === 'pdf') {
        state.sheetNames = ['PDF']; state.sheets = { PDF: await extractPdfTable(buf) };
      } else if (ext === 'csv' || ext === 'txt') {
        setWorkbook(XLSX.read(decodeText(buf), { type: 'string', raw: true }));
      } else {
        setWorkbook(XLSX.read(buf, { type: 'array', raw: true, cellDates: false }));
      }
      state.fileLoaded = true; state.excluded = new Set(); state.rows = []; state.forcedHeaderIdx = null;
      info.textContent = `✔ ${name}（${(size / 1024).toFixed(1)} KB）を読み込みました`;
      $('sheet').innerHTML = state.sheetNames.map((n) => `<option>${esc(n)}</option>`).join('');
      state.sheetName = state.sheetNames[0];
      analyzeSheet();
      goStep(2);
    } catch (e) {
      console.error(e);
      info.className = 'fileinfo err';
      info.textContent = `読み込みに失敗しました: ${e.message}`;
    }
  }

  function decodeText(buf) {
    const u8 = new Uint8Array(buf);
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
  function analyzeSheet() {
    const raw = (state.sheets[state.sheetName] || []).map((r) => r.map((c) => (c == null ? '' : String(c).trim())));
    state.raw = raw;
    const a = O.analyze(raw, currentKind(), state.forcedHeaderIdx);
    state.table = a.table; state.headerIdx = a.headerIdx; state.info = a.info; state.notes = a.notes;
    // 同じ見出しのファイルなら前回の手直しを復元
    const headers = state.table[state.headerIdx] || [];
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(headerSignature(headers)) || 'null'); } catch (_) { /* ignore */ }
    if (saved) { state.mapping = saved; state.info = {}; for (const k of Object.keys(saved)) state.info[k] = { method: 'saved', reason: '前回の設定' }; }
    else state.mapping = a.mapping;
    // 見出し行セレクタ（自動整理後の表ではなく元の表で表示）
    const hs = $('headerRow');
    hs.innerHTML = raw.slice(0, 30).map((r, i) => `<option value="${i}">${i + 1}行目: ${esc(r.filter(Boolean).slice(0, 5).join(' | ')).slice(0, 60)}</option>`).join('');
    hs.value = String(a.hasHeader ? state.headerIdx : (state.forcedHeaderIdx != null ? state.forcedHeaderIdx : 0));
    renderMapping();
  }

  function headerSignature(headers) { return 'zenginfb.map.' + headers.map(O.normHeader).join('|').slice(0, 400); }
  function dataRows() { return state.table.slice(state.headerIdx + 1).filter((r) => r.some((c) => c !== '')); }
  function mappingComplete() {
    const m = state.mapping;
    const hasBank = m.bankCode != null || m.bankName != null || (m.yuchoKigo != null && m.yuchoBango != null);
    const hasBranch = m.branchCode != null || m.branchName != null || (m.yuchoKigo != null && m.yuchoBango != null);
    const hasAcct = m.accountNo != null || (m.yuchoKigo != null && m.yuchoBango != null);
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
        else if (inf.method === 'saved') basis = `<span class="tag ok">前回</span>`;
        else basis = `<span class="sub">${esc(inf.reason)}</span>`;
      }
      // 銀行コード・支店コードが無くても銀行名・支店名があれば辞書で逆引きできる
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
      try { localStorage.setItem(headerSignature(headers), JSON.stringify(state.mapping)); } catch (_) { /* ignore */ }
      renderMapping();
    }));
    const notes = $('organizeNotes');
    notes.hidden = !state.notes.length;
    notes.innerHTML = state.notes.map((n) => `<div>🧹 ${esc(n)}</div>`).join('');
    const rows = dataRows();
    const totals = rows.filter((r) => O.isTotalRow(r, state.mapping)).length;
    $('rowCount').textContent = `${rows.length - totals} 行を認識${totals ? `（合計行 ${totals} 行を除外）` : ''}`;
    $('toStep3').disabled = !mappingComplete();
  }

  // ------------------------------------------------------------
  // Step 3: 振込元情報のプレビュー（辞書で銀行名を表示）
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
    $(id).addEventListener('input', () => { saveSettings(); if (state.step === 3) updateHeaderPreviews(); });
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
      // 1) 銀行名 → 銀行コード の逆引き
      for (const r of rows) {
        if (r.bankCode || !r._rawBankName) continue;
        const c = D.findBank(r._rawBankName);
        const exact = c.filter((x) => x.exact);
        if (exact.length === 1 || (exact.length === 0 && c.length === 1)) {
          const hit = exact[0] || c[0];
          r.bankCode = hit.code;
          r._info.push(`銀行名「${r._rawBankName}」から銀行コード ${hit.code}（${hit.name}）を補いました`);
        } else if (c.length > 1) {
          r._warn.push(`銀行名「${r._rawBankName}」に候補が複数あります: ${c.slice(0, 4).map((x) => `${x.code} ${x.name}`).join(' / ')}`);
        } else {
          r._warn.push(`銀行名「${r._rawBankName}」が金融機関一覧に見つかりません`);
        }
      }
      const codes = [...new Set(rows.map((r) => r.bankCode).filter(Boolean))];
      await Promise.all(codes.map((c) => D.branches(c)));
      // 2) 支店名 → 支店コード の逆引き
      for (const r of rows) {
        if (r.branchCode || !r._rawBranchName || !r.bankCode) continue;
        const c = D.findBranch(r.bankCode, r._rawBranchName);
        const exact = c.filter((x) => x.exact);
        if (exact.length === 1 || (exact.length === 0 && c.length === 1)) {
          const hit = exact[0] || c[0];
          r.branchCode = hit.code;
          r._info.push(`支店名「${r._rawBranchName}」から支店コード ${hit.code}（${hit.name}）を補いました`);
        } else if (c.length > 1) {
          r._warn.push(`支店名「${r._rawBranchName}」に候補が複数あります: ${c.slice(0, 4).map((x) => `${x.code} ${x.name}`).join(' / ')}`);
        } else {
          r._warn.push(`支店名「${r._rawBranchName}」がこの銀行の支店一覧に見つかりません`);
        }
      }
      // 3) コードの存在チェックと名称補完
      const fill = $('fillNames').value === '1';
      for (const r of rows) {
        const b = D.bank(r.bankCode);
        const merged = D.mergedInfo(r.bankCode);
        if (merged) r._warn.push(`銀行コード ${r.bankCode} は ${merged.name}（${merged.date}）で新コード ${merged.new} に変わっています。${merged.branchNote || ''}`);
        else if (!b) { if (r.bankCode) r._warn.push(`銀行コード ${r.bankCode} は金融機関一覧（${D.version}版）にありません。統廃合か入力ミスの可能性があります`); }
        else {
          r._dictBank = b[0];
          if (fill && !r.bankName) r.bankName = Z.toZenginChars(b[1], { abbreviateCorp: false }).slice(0, 15);
          const br = D.branch(r.bankCode, r.branchCode);
          if (br) { r._dictBranch = br[0]; if (fill && !r.branchName) r.branchName = Z.toZenginChars(br[1], { abbreviateCorp: false }).slice(0, 15); }
          else if (br === null && r.branchCode) r._warn.push(`支店コード ${r.branchCode} は ${b[0]}銀行の支店一覧にありません`);
        }
      }
    }
    renderPreview();
  }

  function renderPreview() {
    const kind = currentKind();
    const tbl = $('preview');
    const cols = ['状態', '行', '銀行', '支店', '種目', '口座番号', '受取人名（半角カナ）', '金額'];
    if (kind === '21') cols.push('顧客コード'); else cols.push('社員番号', '所属');
    cols.push('メッセージ');
    let html = '<thead><tr><th></th>' + cols.map((c) => `<th class="${c === '金額' ? 'r' : ''}">${c}</th>`).join('') + '</tr></thead><tbody>';
    let okCount = 0, ngCount = 0, warnCount = 0, total = 0;
    state.rows.forEach((r, i) => {
      const errs = Z.validateRow(r, kind);
      const warns = r._warn || [], infos = r._info || [];
      const skipped = state.excluded.has(r._src);
      if (!skipped) { if (errs.length) ngCount++; else { okCount++; total += r.amount; if (warns.length) warnCount++; } }
      const dep = { 1: '普通', 2: '当座', 4: '貯蓄', 9: 'その他' }[r.depositType] || r.depositType;
      const status = skipped ? '<span class="tag">除外</span>' : errs.length ? '<span class="tag ng">エラー</span>' : warns.length ? '<span class="tag warn">確認</span>' : '<span class="tag ok">OK</span>';
      html += `<tr class="${skipped ? 'skip' : errs.length ? 'bad' : warns.length ? 'warn' : ''}" data-i="${i}">`
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
    generate(ngCount === 0 && okCount > 0);
  }

  // ------------------------------------------------------------
  // 生成・ダウンロード
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
    const rows = state.rows.filter((r) => !state.excluded.has(r._src));
    const he = $('headerErrors');
    he.hidden = !hErrs.length;
    he.innerHTML = hErrs.length ? `振込元の情報を確認してください: ${esc(hErrs.join(' / '))} <button class="btn" data-go="3" style="margin-left:8px">直す</button>` : '';
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
      btn.disabled = false;
      $('downloadName').textContent = `${lastName}（${lastBytes.length.toLocaleString()} バイト・${out.count} 件・¥${out.total.toLocaleString()}）`;
      $('ruler').textContent = '         1         2         3         4         5         6         7         8         9        10        11        12\n123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890';
      $('out').textContent = out.records.join('\n');
    } catch (e) {
      btn.disabled = true; lastBytes = null;
      $('downloadName').textContent = `生成エラー: ${e.message}`;
    }
  }

  $('download').addEventListener('click', () => {
    if (!lastBytes) return;
    const blob = new Blob([lastBytes], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = lastName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ------------------------------------------------------------
  // PDF → 表（テキスト層のあるPDFのみ。座標で行と列を復元する）
  // ------------------------------------------------------------
  async function extractPdfTable(buf) {
    if (!window.pdfjsLib) throw new Error('PDF ライブラリが読み込めませんでした');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const rows = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      const items = tc.items.filter((it) => it.str && it.str.trim()).map((it) => ({ x: it.transform[4], y: it.transform[5], w: it.width, s: it.str }));
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      const lines = [];
      for (const it of items) {
        const ln = lines.find((l) => Math.abs(l.y - it.y) <= 3);
        if (ln) ln.items.push(it); else lines.push({ y: it.y, items: [it] });
      }
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
  if (!G.configured()) $('gsheetHint').textContent = 'Googleスプレッドシート連携は準備中です。いまは「ファイル→ダウンロード→Excel」で保存して読み込んでください。';
  D.load().then(() => { $('dictInfo').textContent = `金融機関一覧: ${D.version} 版（全銀協公開データ）。統廃合があった場合は一覧を更新すると自動で反映されます。`; })
    .catch(() => { $('dictInfo').textContent = '金融機関一覧を読み込めませんでした（銀行名の表示とコードの照合は行われません）'; });
})();
