#!/usr/bin/env python3
"""
make_input_samples.py — 入力形式ごとの検証用ファイルを、同じ中身で作る。

  python tools/make_input_samples.py <出力先ディレクトリ>

作るもの（すべて同じ6件・合計 ¥1,234,567）:
  input.xlsx / input.xls / input_utf8.csv / input_utf8bom.csv / input_sjis.csv
  input_textpdf.pdf（フォント埋め込み・Excel の「PDFで保存」に近い形）
  input_cidpdf.pdf（フォント非埋め込みの日本語 CID フォント）
見出しは日本語で、列の並びは全銀の順番どおりではない（自動整理の確認も兼ねる）。
"""
import csv
import os
import sys

HEAD = ['氏名（カナ）', '金額', '銀行名', '支店名', '預金種目', '口座番号', '社員番号']
ROWS = [
    ['ヤマダ タロウ', 250000, 'みずほ銀行', '東京営業部', '普通', '1234567', '101'],
    ['カ）ココキカク', 330000, '三井住友銀行', '本店営業部', '当座', '7654321', '102'],
    ['スズキ ハナコ', 198765, 'ゆうちょ銀行', '〇一八', '普通', '1234567', '103'],
    ['センター イチロウ', 150000, '京都中央信用金庫', '本店', '普通', '0012345', '104'],
    ['キャノン ジロウ', 205802, '京都信用金庫', '本店', '普通', '0023456', '105'],
    ['ワタナベ ミキ', 100000, 'PayPay銀行', 'すずめ支店', '普通', '1112223', '106'],
]
TOTAL = sum(r[1] for r in ROWS)


def main(out):
    os.makedirs(out, exist_ok=True)
    import openpyxl
    import xlwt
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = '振込一覧'
    ws.append(['10月分 給与振込一覧']); ws.append([])
    ws.append(HEAD)
    for r in ROWS: ws.append(r)
    ws.append(['合計', TOTAL])
    wb.save(os.path.join(out, 'input.xlsx'))

    wb2 = xlwt.Workbook(encoding='utf-8'); s2 = wb2.add_sheet('振込一覧')
    for c, v in enumerate(HEAD): s2.write(0, c, v)
    for i, r in enumerate(ROWS, 1):
        for c, v in enumerate(r): s2.write(i, c, v)
    wb2.save(os.path.join(out, 'input.xls'))

    for name, enc in (('input_utf8.csv', 'utf-8'), ('input_utf8bom.csv', 'utf-8-sig'), ('input_sjis.csv', 'cp932')):
        with open(os.path.join(out, name), 'w', encoding=enc, newline='') as f:
            w = csv.writer(f); w.writerow(HEAD); w.writerows(ROWS)

    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont

    def pdf(path, font):
        c = canvas.Canvas(path, pagesize=A4)
        c.setFont(font, 14); c.drawString(40, 800, '10月分 給与振込一覧')
        xs = [40, 150, 220, 330, 420, 470, 540]
        y = 770
        c.setFont(font, 9)
        for i, h in enumerate(HEAD): c.drawString(xs[i], y, h)
        for r in ROWS:
            y -= 18
            for i, v in enumerate(r):
                c.drawString(xs[i], y, f'{v:,}' if isinstance(v, int) else str(v))
        y -= 18; c.drawString(xs[0], y, '合計'); c.drawString(xs[1], y, f'{TOTAL:,}')
        c.save()

    pdfmetrics.registerFont(TTFont('Meiryo', 'C:/Windows/Fonts/meiryo.ttc', subfontIndex=0))
    pdf(os.path.join(out, 'input_textpdf.pdf'), 'Meiryo')
    pdfmetrics.registerFont(UnicodeCIDFont('HeiseiKakuGo-W5'))
    pdf(os.path.join(out, 'input_cidpdf.pdf'), 'HeiseiKakuGo-W5')
    print('total', TOTAL, 'rows', len(ROWS))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '.')
