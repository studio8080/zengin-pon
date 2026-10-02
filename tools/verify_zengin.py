#!/usr/bin/env python3
"""
verify_zengin.py — 全銀フォーマット（総合振込・給与振込・賞与振込）のファイルを1バイトずつ検査する。

変換エンジン（src/zengin.js）とは別に、全銀協の固定長レイアウトだけを根拠に書いた検査器。
同じ人が同じ思い込みで書いたコード同士で「合っている」と言わないための、独立したもう一つの目。

  python tools/verify_zengin.py ファイル [ファイル ...]

終了コード: 0 = 問題なし / 1 = エラーあり（警告だけなら 0）
"""
import sys

REC = 120

# 文字項目に使える文字（全銀協の受取人名などの使用可能文字）
DIGITS = set('0123456789')
UPPER = set('ABCDEFGHIJKLMNOPQRSTUVWXYZ')
KANA = set(bytes(range(0xB1, 0xDE)).decode('cp932'))   # ｱ〜ﾝ
KANA |= set('ﾞﾟ')                                      # 濁点・半濁点
SYMBOLS = set(' ().-/¥,')
SYMBOLS_BYTES = {0x20, 0x28, 0x29, 0x2E, 0x2D, 0x2F, 0x5C, 0x2C, 0xA2, 0xA3}  # 空白 ( ) . - / ¥ , ｢ ｣
ALLOWED_BYTES = {ord(c) for c in DIGITS | UPPER} | set(range(0xB1, 0xE0)) | SYMBOLS_BYTES  # 長音ｰ(0xB0)・小書きカナは含めない
# 銀行によって扱いが分かれる文字（エラーではなく警告にする）
# 「ｦ」は使える銀行と使えない銀行がある（PayPay銀行は可、福井銀行などは「ｵ」で入力）
WARN_BYTES = {0xA6: '「ｦ」'}
# 長音「ｰ」は「-」、小書きカナは大きいカナで書く決まり（銀行の入力基準）なので、エラーとして名前を出す
ERR_NAMES = {0xB0: '長音「ｰ」（「-」に置き換える）'}
ERR_NAMES.update({b: '小書きカナ（大きいカナで書く）' for b in range(0xA7, 0xB0)})


def kind_name(k):
    return {'21': '総合振込', '11': '給与振込', '12': '賞与振込'}.get(k, f'不明({k})')


class Checker:
    def __init__(self, path):
        self.path = path
        self.errors = []
        self.warnings = []

    def err(self, rec_no, msg):
        self.errors.append(f'{rec_no}件目のレコード: {msg}')

    def warn(self, rec_no, msg):
        self.warnings.append(f'{rec_no}件目のレコード: {msg}')

    def num(self, rec_no, rec, start, length, label, allow_space=False):
        f = rec[start:start + length]
        if allow_space and f == b' ' * length:
            return None
        if not all(0x30 <= b <= 0x39 for b in f):
            self.err(rec_no, f'{label}（{start + 1}〜{start + length}バイト目）が数字ではありません: {f!r}')
            return None
        return int(f)

    def chars(self, rec_no, rec, start, length, label):
        f = rec[start:start + length]
        for i, b in enumerate(f):
            if b in ALLOWED_BYTES:
                continue
            if b in WARN_BYTES:
                self.warn(rec_no, f'{label}に{WARN_BYTES[b]}があります（{start + i + 1}バイト目）。銀行によっては使えません')
            elif b in ERR_NAMES:
                self.err(rec_no, f'{label}に{ERR_NAMES[b]}があります（{start + i + 1}バイト目）')
            else:
                self.err(rec_no, f'{label}に使えない文字があります（{start + i + 1}バイト目: 0x{b:02X}）')
        if f[:1] == b' ' and f.strip():
            self.warn(rec_no, f'{label}が空白で始まっています（左詰めが原則）')

    def run(self):
        raw = open(self.path, 'rb').read()
        # 改行の判定（CRLF / LF / なし）
        if b'\r\n' in raw:
            nl = 'CRLF'
            body = raw.replace(b'\r\n', b'')
        elif b'\n' in raw:
            nl = 'LF'
            body = raw.replace(b'\n', b'')
        else:
            nl = 'なし'
            body = raw
        if body.endswith(b'\x1a'):
            body = body[:-1]
            self.warnings.append('末尾に EOF（0x1A）があります。不要な銀行では取込エラーになります')
        if nl != 'なし':
            lines = raw.split(b'\r\n' if nl == 'CRLF' else b'\n')
            if lines and lines[-1] == b'':
                lines = lines[:-1]
            for i, ln in enumerate(lines, 1):
                if len(ln) != REC:
                    self.err(i, f'レコード長が {len(ln)} バイトです（120 であるべき）')
        if len(body) % REC:
            self.errors.append(f'全体の長さ {len(body)} バイトが 120 の倍数ではありません')
            return self.report(nl, None, 0, 0)
        recs = [body[i:i + REC] for i in range(0, len(body), REC)]
        if not recs:
            self.errors.append('レコードがありません')
            return self.report(nl, None, 0, 0)

        # ---- 並び: 1 → 2... → 8 → 9 ----
        kinds = bytes(r[0] for r in recs)
        if kinds[:1] != b'1':
            self.err(1, '先頭がヘッダー（データ区分 1）ではありません')
        if kinds[-1:] != b'9':
            self.err(len(recs), '最後がエンド（データ区分 9）ではありません')
        if len(recs) < 4 or kinds[-2:-1] != b'8':
            self.err(len(recs) - 1, 'エンドの直前がトレーラ（データ区分 8）ではありません')
        if any(k != ord('2') for k in kinds[1:-2]):
            self.errors.append('ヘッダーとトレーラのあいだにデータ（データ区分 2）以外のレコードがあります')

        # ---- ヘッダー ----
        h = recs[0]
        kind = h[1:3].decode('ascii', 'replace')
        if kind not in ('21', '11', '12'):
            self.err(1, f'種別コードが {kind} です（21 総合 / 11 給与 / 12 賞与）')
        if h[3:4] not in (b'0', b'1'):
            self.err(1, f'コード区分が {h[3:4]!r} です（0 = JIS）')
        self.num(1, h, 4, 10, '振込依頼人コード')
        self.chars(1, h, 14, 40, '振込依頼人名')
        if not h[14:54].strip():
            self.err(1, '振込依頼人名が空です')
        mmdd = self.num(1, h, 54, 4, '取組日')
        if mmdd is not None and not (1 <= mmdd // 100 <= 12 and 1 <= mmdd % 100 <= 31):
            self.err(1, f'取組日 {mmdd:04d} が日付になっていません（MMDD）')
        self.num(1, h, 58, 4, '仕向銀行番号')
        self.chars(1, h, 62, 15, '仕向銀行名')
        self.num(1, h, 77, 3, '仕向支店番号')
        self.chars(1, h, 80, 15, '仕向支店名')
        if h[95:96] not in (b'1', b'2', b'4', b'9'):
            self.err(1, f'依頼人の預金種目が {h[95:96]!r} です（1 普通 / 2 当座 / 4 貯蓄 / 9 その他）')
        self.num(1, h, 96, 7, '依頼人の口座番号')
        if h[103:120] != b' ' * 17:
            self.err(1, 'ヘッダー末尾のダミー（104〜120バイト目）が空白ではありません')

        # ---- データ ----
        total = 0
        datas = recs[1:-2] if len(recs) >= 4 else []
        for n, d in enumerate(datas, 2):
            self.num(n, d, 1, 4, '銀行番号')
            self.chars(n, d, 5, 15, '銀行名')
            self.num(n, d, 20, 3, '支店番号')
            self.chars(n, d, 23, 15, '支店名')
            if d[38:42] != b'    ' and not all(0x30 <= b <= 0x39 for b in d[38:42]):
                self.err(n, '手形交換所番号（39〜42バイト目）は空白か数字です')
            if d[42:43] not in (b'1', b'2', b'4', b'9'):
                self.err(n, f'預金種目が {d[42:43]!r} です（1 普通 / 2 当座 / 4 貯蓄 / 9 その他）')
            self.num(n, d, 43, 7, '口座番号')
            self.chars(n, d, 50, 30, '受取人名')
            if not d[50:80].strip():
                self.err(n, '受取人名が空です')
            amt = self.num(n, d, 80, 10, '振込金額')
            if amt is not None:
                if amt <= 0:
                    self.err(n, '振込金額が 0 円です')
                total += amt
            if d[90:91] not in (b'0', b'1', b'2'):
                self.err(n, f'新規コードが {d[90:91]!r} です（0 / 1 / 2）')
            if kind == '21':
                edi = d[112:113]
                if edi == b'Y':
                    self.chars(n, d, 91, 20, 'EDI情報')
                else:
                    self.num(n, d, 91, 10, '顧客コード1', allow_space=True)
                    self.num(n, d, 101, 10, '顧客コード2', allow_space=True)
                if d[111:112] not in (b'7', b'8', b' '):
                    self.err(n, f'振込指定区分が {d[111:112]!r} です（7 電信 / 8 文書）')
                if edi not in (b'Y', b' '):
                    self.err(n, f'識別表示が {edi!r} です（Y か空白）')
                if d[113:120] != b' ' * 7:
                    self.err(n, '末尾のダミー（114〜120バイト目）が空白ではありません')
            else:
                self.num(n, d, 91, 10, '社員番号', allow_space=True)
                self.num(n, d, 101, 10, '所属コード', allow_space=True)
                if d[111:120] != b' ' * 9:
                    self.err(n, '末尾のダミー（112〜120バイト目）が空白ではありません')

        # ---- トレーラ・エンド ----
        if len(recs) >= 4:
            t = recs[-2]
            cnt = self.num(len(recs) - 1, t, 1, 6, '合計件数')
            tot = self.num(len(recs) - 1, t, 7, 12, '合計金額')
            if cnt is not None and cnt != len(datas):
                self.err(len(recs) - 1, f'合計件数 {cnt} と実際のデータ件数 {len(datas)} が合いません')
            if tot is not None and tot != total:
                self.err(len(recs) - 1, f'合計金額 {tot:,} と各行の合計 {total:,} が合いません')
            if t[19:120] != b' ' * 101:
                self.err(len(recs) - 1, 'トレーラのダミーが空白ではありません')
        e = recs[-1]
        if e[1:120] != b' ' * 119:
            self.err(len(recs), 'エンドのダミーが空白ではありません')
        return self.report(nl, kind, len(datas), total)

    def report(self, nl, kind, count, total):
        print(f'■ {self.path}')
        if kind:
            print(f'  種別: {kind_name(kind)} / 改行: {nl} / 件数: {count} / 合計: ¥{total:,}')
        for e in self.errors:
            print('  ✗', e)
        for w in self.warnings:
            print('  △', w)
        if not self.errors:
            print('  ✓ 全銀フォーマットとして問題ありません' + ('（警告あり）' if self.warnings else ''))
        return not self.errors


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    ok = all([Checker(p).run() for p in argv])
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
