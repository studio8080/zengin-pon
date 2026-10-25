(function () {
  'use strict';
  const C = window.TransferCompare, el = id => document.getElementById(id);
  const fields = [['bankCode', '銀行コード'], ['branchCode', '支店コード'], ['depositType', '預金種目 (1/2/4)'], ['accountNo', '口座番号'], ['name', '名義'], ['amount', '金額'], ['id', '安定識別子（任意）']];
  const loaded = {}, versions = { before: 0, after: 0 };
  const node = (tag, value) => { const n = document.createElement(tag); if (value != null) n.textContent = value; return n; };
  const reset = () => { el('compareResult').replaceChildren(); el('compareMessage').textContent = ''; };
  for (const side of ['before', 'after']) {
    const box = el('compare-' + side);
    const file = box.querySelector('input'), sheet = box.querySelector('select'), mapping = box.querySelector('.compare-mapping');
    const showSheet = () => {
      reset(); mapping.replaceChildren();
      const table = loaded[side].sheets[sheet.value];
      const headers = table[0] || [];
      fields.forEach(([key, title]) => {
        const label = node('label', title), sel = node('select'); sel.dataset.field = key;
        sel.append(new Option(key === 'id' ? '使用しない' : '列を選ぶ', ''));
        headers.forEach((h, i) => sel.append(new Option(`${i + 1}: ${h}`, String(i))));
        sel.addEventListener('change', reset); label.append(sel); mapping.append(label);
      });
      const preview = node('p', `1行目を見出しとして扱います。データ ${Math.max(0, table.length - 1)}行。先頭行: ${(table[1] || []).join(' / ')}`);
      preview.className = 'note'; mapping.append(preview);
    };
    sheet.addEventListener('change', showSheet);
    file.addEventListener('change', async () => {
      const version = ++versions[side]; delete loaded[side]; mapping.replaceChildren(); sheet.replaceChildren(); reset();
      const f = file.files[0]; if (!f) return;
      try {
        if (!/\.(csv|tsv|xlsx|xls)$/i.test(f.name)) throw new Error('CSV・TSV・Excel のみ対応します。固定長FBファイルはまだ読めません。');
        if (f.size > 10 * 1024 * 1024) throw new Error('10MB以下のファイルを選んでください');
        const buf = await f.arrayBuffer();
        let wb;
        if (/\.(csv|tsv)$/i.test(f.name)) {
          let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (_) { text = new TextDecoder('shift_jis', { fatal: true }).decode(buf); }
          wb = XLSX.read(text, { type: 'string', raw: true });
        } else wb = XLSX.read(buf, { type: 'array', raw: true });
        if (version !== versions[side]) return;
        const sheets = {};
        for (const name of wb.SheetNames) {
          const table = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
          if (table.length > 10001) throw new Error('1シート10,000行まで対応します');
          sheets[name] = table;
        }
        loaded[side] = { sheets }; wb.SheetNames.forEach(name => sheet.append(new Option(name, name))); showSheet();
      } catch (e) { if (version === versions[side]) { delete loaded[side]; el('compareMessage').textContent = e.message; } }
    });
  }
  function rows(side) {
    if (!loaded[side]) throw new Error('前月と今回のファイルを選んでください');
    const box = el('compare-' + side), sels = [...box.querySelectorAll('[data-field]')];
    if (sels.some(s => s.dataset.field !== 'id' && s.value === '')) throw new Error('両方のファイルの必須列をすべて選んでください');
    const indices = sels.filter(s => s.value !== '').map(s => s.value);
    if (new Set(indices).size !== indices.length) throw new Error('同じ列を複数の項目に指定できません');
    const table = loaded[side].sheets[box.querySelector('select').value];
    const data = table.slice(1).filter(r => r.some(v => String(v).trim() !== '')).map((r, i) => {
      try { return C.normalize(Object.fromEntries(sels.map(s => [s.dataset.field, s.value === '' ? '' : r[Number(s.value)]]))); }
      catch (e) { throw new Error(`${side === 'before' ? '前月' : '今回'}のデータ行${i + 1}: ${e.message}`); }
    });
    if (!data.length) throw new Error('データ行がありません');
    return data;
  }
  el('compareRun').addEventListener('click', () => {
    reset();
    try {
      const b = rows('before'), a = rows('after');
      const ids = ['before', 'after'].map(s => el('compare-' + s).querySelector('[data-field="id"]').value !== '');
      if (ids[0] !== ids[1]) throw new Error('識別子は両方で同じ意味の列を指定するか、両方「使用しない」にしてください');
      const r = C.compare(b, a, ids[0]), out = el('compareResult'), yen = n => `${n.toLocaleString('ja-JP')}円`;
      out.append(node('p', `前月 ${b.length}件 / ${yen(r.beforeTotal)} → 今回 ${a.length}件 / ${yen(r.afterTotal)}。合計差 ${yen(r.totalDelta)}`));
      const describe = x => `${x.name} [${x.id || '識別子なし'}] ${C.account(x)} ${yen(x.amount)}`;
      const list = (title, values) => {
        out.append(node('h3', `${title} (${values.length}件)`)); const ul = node('ul');
        values.forEach(v => ul.append(node('li', v))); out.append(ul);
      };
      list('今回だけの行（追加・未照合）', r.added.map(describe));
      list('前月だけの行（消えた・未照合）', r.removed.map(describe));
      list('口座変更候補（指定識別子一致・要確認）', r.matches.filter(x => x.accountChanged).map(x => `${describe(x.before)} → ${describe(x.after)}`));
      list('照合した行と金額差', r.matches.map(x => `${describe(x.before)} → ${describe(x.after)} / 差 ${yen(x.delta)} / ${x.basis}${x.nameChanged ? ' / 名義も変更' : ''}`));
      list('曖昧さ・要確認', r.ambiguous.map(x => `${x.reason}。前月行 ${x.before.map(i => i + 1).join(', ') || 'なし'} / 今回行 ${x.after.map(i => i + 1).join(', ') || 'なし'}`));
    } catch (e) { el('compareMessage').textContent = e.message; }
  });
  el('compareClear').addEventListener('click', () => {
    for (const s of ['before', 'after']) { ++versions[s]; delete loaded[s]; const box = el('compare-' + s); box.querySelector('input').value = ''; box.querySelector('select').replaceChildren(); box.querySelector('.compare-mapping').replaceChildren(); }
    reset();
  });
})();
