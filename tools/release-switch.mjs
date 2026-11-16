// release-switch.mjs — 公開に切り替えるための書き換え。既定は「何を変えるかを表示するだけ」で、ファイルは変えない。
// 使い方: node tools/release-switch.mjs          … 変更点の表示だけ
//         node tools/release-switch.mjs --apply  … 書き換える（経営者の公開の承認の後だけ使う）。その後 node build.js
// 書き換えるもの：①検索に載せない設定（noindex）を外す ②試作の帯を外す ③build.js の SITE_URL に本番のURLを入れる
// 書き換えないもの：フォームの「試作のため無効」の表示（フォームを出すか隠すかは経営者が決める）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_PROD = 'https://kaigoweekly.jp/';
const apply = process.argv.includes('--apply');

const rules = [
  ['index.html', /^<meta name="robots" content="noindex, nofollow">\r?\n/m, '', 'noindex を外す'],
  ['index.html', /^<div class="sample-bar"[^\n]*<\/div>\r?\n/m, '', '試作の帯を外す'],
  ['article-template.html', /^<meta name="robots" content="noindex, nofollow">\r?\n/m, '', 'noindex を外す'],
  ['article-template.html', /^<div class="sample-bar"[^\n]*<\/div>\r?\n/m, '', '試作の帯を外す'],
  ['build.js', /^const SITE_URL = '';/m, `const SITE_URL = '${URL_PROD}';`, 'SITE_URL に本番のURLを入れる'],
];

let n = 0;
for (const [rel, re, to, label] of rules) {
  const p = path.join(SITE, rel);
  const s = fs.readFileSync(p, 'utf8');
  const m = s.match(re);
  if (!m) { console.log(`- ${rel}：${label} … 該当なし（済みか、形が変わった）`); continue; }
  console.log(`- ${rel}：${label}\n    消す／変える行：${m[0].trim()}`);
  if (apply) { fs.writeFileSync(p, s.replace(re, to)); n++; }
}
console.log(apply ? `\n${n}か所を書き換えた。次に node build.js と node tools/make-dist.mjs を実行する。` : '\n表示だけ（ファイルは変えていない）。');
