# pdf.js の CMap（文字の対応表）

`cmaps/` は pdfjs-dist@3.11.174（npm）に含まれる CMap をそのまま置いたもの。
日本語の CID フォントを埋め込まない PDF（給与ソフトの出力などに多い）から文字を取り出すのに必要。
cdnjs には置かれていないため、自サイトから配信する（CSP は 'self' のままで済む）。
pdf.js 本体（index.html で cdnjs から読み込み）の版を上げたら、ここも同じ版に差し替える。
ライセンス: pdf.js は Apache-2.0（LICENSE）。CMap は Adobe の BSD-3-Clause（cmaps/LICENSE）。
