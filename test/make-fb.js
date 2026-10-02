// node test/make-fb.js <出力先ディレクトリ> — 間違えやすい名義を含む表から全銀ファイルを作る（tools/verify_zengin.py で検査する用）
const fs = require('node:fs');
const path = require('node:path');
const Z = require('../src/zengin.js');

const dir = process.argv[2] || '.';
const yu = Z.yuchoToZengin('12340', '12345671');
const names = ['株式会社ココキカク', 'ヤマダ　タロウ', 'ガッコウホウジン　サクラ', 'ＡＢＣショウジ株式会社', 'エー・ビー・シー',
  'ニホン（カ', 'ゴトウ　ヒロミ', ' スズキ　イチロウ', 'マンション管理組合法人サクラ', 'ヴィクター', 'キャノン', 'カ）ココキカク　センター'];
const rows = names.map((n, i) => ({
  bankCode: i === 6 ? yu.bankCode : '0005', bankName: '', branchCode: i === 6 ? yu.branchCode : '001', branchName: '',
  depositType: i === 6 ? yu.depositType : (i % 3 === 2 ? '2' : '1'), accountNo: i === 6 ? yu.accountNo : String(1000000 + i),
  name: Z.toZenginChars(n.trim()), amount: String(1000 * (i + 1) + i),
}));
for (const [kind, nl] of [['21', 'CRLF'], ['11', 'LF'], ['12', 'none']]) {
  const h = { kind, clientCode: '1234567890', clientName: Z.toZenginChars('株式会社ココキカク'), date: '1015',
    bankCode: '0005', bankName: '', branchCode: '001', branchName: '', depositType: '1', accountNo: '7654321' };
  for (const r of rows) if (Z.invalidChars(r.name).length) throw new Error('使えない文字が残っています: ' + r.name);
  fs.writeFileSync(path.join(dir, `fb_${kind}_${nl}.txt`), Buffer.from(Z.encode(Z.build(h, rows, { newline: nl }).text)));
}
