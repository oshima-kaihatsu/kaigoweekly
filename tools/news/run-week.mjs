// run-week.mjs — 1週間分のニュースを、1コマンドで「ネタ集め→下書き→一次情報との照合→組み立て」まで進める。
// 使い方: node tools/news/run-week.mjs 2026-W45 [--no-publish]
//        2026-11-16 から GitHub Actions（.github/workflows/weekly-news.yml）で毎週月曜 6:30 に動かす。
//        Actions では --no-publish で記事づくりまでを行い、公開（make-dist と wrangler deploy）は別の手順で行う（Cloudflare の鍵を AI の手順に渡さないため）
//        週を省くと「先週」（実行日の前の月〜日、日本時間）を対象にする。
// 公開・投稿・送信はしない。組み立て（node build.js）はこのPCの中の html を作るだけ。
//
// 安全のための作り（2026-11-11 Codex のレビューを受けて作り直し）
// - AI（Claude Code、claude -p）は、プロジェクトの外の作業用フォルダ（%LOCALAPPDATA%/carejin-news/<週>/<実行ID>/）だけで動かす。
//   --restricted で、コマンドやコードを動かす道具を外し、ファイルの道具を作業用フォルダの中だけに閉じ込める（AIへの指示ではなく、Claude Code 側の制限）。
//   参考にする記事や決まりは、作業用フォルダにコピーして渡す。AIは build.js やサイトのファイルに触れない。
// - 下書きと照合は別々の実行（書く役と確かめる役を分ける）。照合の結果は AI の「合格」をそのまま使わず、明細からこのプログラムが合否を計算し直す。
// - 記事名・ファイルの形・出典のURL（一次情報の所管のドメイン）を、このプログラムが確かめてから articles/ に入れる。
// - 同じ週をやり直したときは、今回入れられる合格記事が1本以上あるときだけ、前回この仕組みが入れたその週の記事を外して入れ直す。
//   0本なら前回の記事を残し、試しの結果だけを別に記録する（人が書いた記事は触らない）。
// - ネタ集めが不完全なら止める。どの工程で止まっても、組み立ては最後に必ずやり直す。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {weekRange} from './collect.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(DIR, '..', '..');
const ART = path.join(SITE, 'articles');
const STATE = path.join(DIR, 'generated.json'); // 週ごとに、この仕組みが入れた記事と照合の結果
const LIST = path.join(DIR, '確認一覧.md');
// 一次情報は記事の種類で分ける（2026-11-11 Codex の指摘）
// 制度・統計など（stage が「調査」以外）：官公庁のページだけ。企業・団体の調査（stage: 調査）：そのリリースのページ（PR TIMES）か官公庁のページ
const GOV = /^https:\/\/([a-z0-9-]+\.)*(mhlw\.go\.jp|cfa\.go\.jp|e-gov\.go\.jp|go\.jp)\//;
const PRT = /^https:\/\/prtimes\.jp\/main\/html\/rd\/p\/[0-9.]+\.html/;
const stageOf = (t) => ((/^stage:\s*(.+)$/m.exec(t) || [])[1] || '').trim();
const primaryFor = (stage) => (stage === '調査' ? (u) => GOV.test(u) || PRT.test(u) : (u) => GOV.test(u));
const NAME = /^topic-[a-z0-9]+(-[a-z0-9]+)*$/;
const args = process.argv.slice(2);

function lastWeek() {
  const d = new Date(Date.now() + 9 * 3600e3);
  d.setUTCDate(d.getUTCDate() - 7);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7));
  const y = t.getUTCFullYear(), jan4 = new Date(Date.UTC(y, 0, 4));
  const wk = 1 + Math.round(((t - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${y}-W${String(wk).padStart(2, '0')}`;
}
const WEEK = args.find((a) => /^\d{4}-W\d{2}$/.test(a)) || lastWeek();
const R = weekRange(WEEK);
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const RUN_ID = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + '-' + crypto.randomBytes(3).toString('hex');
const BASE = path.join(process.env.LOCALAPPDATA || path.join(process.env.HOME || '.', '.local'), 'carejin-news', WEEK, RUN_ID);
const LOGDIR = path.join(DIR, 'logs');
fs.mkdirSync(LOGDIR, {recursive: true});
const LOG = path.join(LOGDIR, `${WEEK}_${RUN_ID}.log`);
const log = (m) => { console.log(m); fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`); };
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;

// 2026-10-26 → 2026年10月26日。終わりの日は、始まりと同じ年なら年を省く
function longDate(d, from) {
  const s = `${+d.slice(5, 7)}月${+d.slice(8, 10)}日`;
  return from && from.slice(0, 4) === d.slice(0, 4) ? s : `${d.slice(0, 4)}年${s}`;
}
function fill(tpl, dir) {
  return tpl.replaceAll('{{WEEK}}', WEEK).replaceAll('{{START}}', R.start).replaceAll('{{LAST}}', R.last).replaceAll('{{WORK}}', '.')
    .replaceAll('{{TODAY}}', today).replaceAll('{{MD_START}}', md(R.start)).replaceAll('{{MD_LAST}}', md(R.last))
    .replaceAll('{{LONG_START}}', longDate(R.start)).replaceAll('{{LONG_LAST}}', longDate(R.last, R.start));
}
// Claude Code を作業用フォルダの中だけで1回動かす
function claude(promptFile, dir, label) {
  const prompt = fill(fs.readFileSync(path.join(DIR, 'prompts', promptFile), 'utf8'), dir);
  log(`${label}：開始（${dir}）`);
  const r = spawnSync('claude', ['-p', '--restricted', '--strict-mcp-config', '--tools', 'Read,Write,Edit,Glob,Grep,WebFetch',
    // WebFetch は官公庁のドメインだけ許可する（無人実行では許可がないと開けない。読めるページを絞ると、悪意ある文を読み込む危険も減る）
    '--allowedTools', 'WebFetch(domain:www.mhlw.go.jp),WebFetch(domain:mhlw.go.jp),WebFetch(domain:www.cfa.go.jp),WebFetch(domain:cfa.go.jp),WebFetch(domain:www.e-gov.go.jp),WebFetch(domain:laws.e-gov.go.jp),WebFetch(domain:prtimes.jp)',
    '--permission-mode', 'acceptEdits', '--output-format', 'text'],
  {cwd: dir, input: prompt, encoding: 'utf8', timeout: 45 * 60e3, shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024});
  fs.writeFileSync(path.join(LOGDIR, `${WEEK}_${RUN_ID}_${label}.txt`), (r.stdout || '') + '\n--- stderr ---\n' + (r.stderr || ''));
  if (r.status !== 0) throw new Error(`${label}が失敗しました（終了コード ${r.status}${r.error ? '、' + r.error.message : ''}）`);
  log(`${label}：終了`);
}

// 作業用フォルダに、参考にする記事・決まり・候補をコピーする（AIはこのフォルダの外を読めない）
function prepare(dir, extra = {}) {
  fs.mkdirSync(path.join(dir, 'articles'), {recursive: true});
  fs.mkdirSync(path.join(dir, 'drafts'), {recursive: true});
  for (const f of ['editorial-policy.md', 'topic-keiei-joho-hokoku-saikai-2026-10.md', 'topic-kaigo-chinage-ritsu-2026.md']) {
    fs.copyFileSync(path.join(ART, f), path.join(dir, 'articles', f));
  }
  fs.copyFileSync(path.join(DIR, 'prompts', 'weekly-sample.md'), path.join(dir, 'articles', 'weekly-sample.md'));
  // 関連度の基準：リポジトリに入れた写し（tools/news/関連度の基準.md、2026-11-16 GitHub Actions 移行で追加）。なければ元のPCのファイル
  const critCopy = path.join(DIR, '関連度の基準.md');
  const crit = fs.existsSync(critCopy) ? fs.readFileSync(critCopy, 'utf8') : fs.readFileSync(path.join(SITE, '..', '保育介護_週次ネタ集計', '00_候補一覧と集計.md'), 'utf8').split('## 情報源と取り方')[0];
  fs.writeFileSync(path.join(dir, '関連度の基準.md'), crit);
  for (const [name, src] of Object.entries(extra)) fs.copyFileSync(src, path.join(dir, name));
}

// 照合の結果を、このプログラムが確かめ直す
function judge(check, drafts, info) {
  if (!check || check.week !== WEEK || !Array.isArray(check.articles)) throw new Error('照合の結果の形が想定と違います（週が違う、または articles がない）');
  const res = [];
  for (const name of drafts) {
    const a = check.articles.find((x) => x && x.file === name + '.md');
    const why = [];
    if (!a) why.push('照合の結果に入っていない');
    const claims = a && Array.isArray(a.claims) ? a.claims : [];
    // 照合の側が「〇〇：問題なし」のような確認済みのメモを issues に書くことがあるため、それは問題として数えない
    const issues = a && Array.isArray(a.issues) ? a.issues.filter((x) => String(x).trim() && !/^[^：:]{1,12}[：:]\s*問題なし/.test(String(x).trim())) : [];
    if (claims.length < 3) why.push(`確かめた記述が${claims.length}件しかない`);
    // 照合の明細が、この下書きの記述・この下書きの出典に結び付いていること
    const unbound = claims.filter((c) => !flat(c.text) || !info[name].text.includes(flat(c.text)) || !info[name].urls.includes(String(c.source || '').trim()));
    if (unbound.length) why.push(`下書きの記述や出典の表と結び付かない明細が${unbound.length}件`);
    const bad = claims.filter((c) => c.result !== '一致');
    if (bad.length) why.push(`一致しない・確認できない記述が${bad.length}件`);
    if (issues.length) why.push(`問題の指摘が${issues.length}件`);
    const isPrimary = primaryFor(info[name].stage);
    if (!claims.some((c) => isPrimary(String(c.source || '')))) why.push('記事の種類に合う一次情報で確かめた記述がない');
    if (info[name].stage === '調査') {
      // 企業・団体の調査：調査の必須事項（主体・時期・対象・回答数・方法）が、照合で一致した記述に入っていること
      // 必須事項ごとに、別々の「一致」の明細（その記事の出典の調査のURLで確かめたもの）があること。回答数は数字と単位を含むこと（2026-11-11 Codex 2回目の指摘）
      const ok = claims.filter((c) => c.result === '一致' && isPrimary(String(c.source || '')));
      const used = new Set();
      for (const [label, re] of [['回答数', /[0-9][0-9,]*\s*(名|人|件|社|事業所|法人)/], ['調査の時期（年月）', /\d{4}年\d{1,2}月|\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/], ['対象', /対象/], ['方法', /方法|インターネット調査|Web調査|ウェブ調査|アンケート調査|調査票|聞き取り/], ['調査した主体', /株式会社|有限会社|一般社団法人|公益社団法人|社団法人|財団法人|協会|団体|法人|会社/]]) {
        const hit = ok.find((c, i) => !used.has(i) && re.test(String(c.text)) && (used.add(i), true));
        if (!hit) why.push(`調査の${label}を確かめた明細がない`);
      }
    }
    res.push({file: name + '.md', pass: why.length === 0, why, claims: claims.length, bad: bad.length + issues.length, aiVerdict: a ? a.verdict : '-'});
  }
  return res;
}

const SOURCES_SEC = /## 出典と段階\n([\s\S]*?)(\n## |$)/;
// 下書きのファイルを確かめる（名前・front-matter・出典表）
function draftOk(p, name) {
  const t = fs.readFileSync(p, 'utf8');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(t.replace(/\r\n/g, '\n'));
  if (!fm) return 'front-matter がない';
  const need = ['kind: topic', 'title:', 'date:', 'period:', 'summary:', 'stage:', 'services:', 'tags:'];
  const miss = need.filter((k) => !fm[1].includes(k));
  if (miss.length) return `front-matter に ${miss.join('・')} がない`;
  if (!fm[1].includes(`period: ${R.start}〜${R.last}`)) return '対象の週（period）が違う';
  const sec = SOURCES_SEC.exec(t.replace(/\r\n/g, '\n'));
  if (!sec) return '「出典と段階」がない';
  const urls = [...sec[1].matchAll(/https?:\/\/[^\s)|>\]]+/g)].map((m) => m[0]);
  const stage = stageOf(fm[1]);
  if (!urls.some(primaryFor(stage))) return stage === '調査' ? '出典の表に調査のリリースか官公庁のURLがない' : '出典の表に官公庁の一次情報のURLがない';
  if (stage === '調査') {
    // 企業・団体の調査：本文に調査の主体・時期・対象・回答数・方法があり、回答数がおおむね300以上（2026-11-11 Codex の指摘）
    const b = t.replace(/^---\n[\s\S]*?\n---\n/, '');
    if (!/企業の調査|団体の調査/.test(b)) return '企業・団体の調査だと明記していない';
    for (const [label, re] of [['対象', /対象/], ['方法', /方法|インターネット|Web|ウェブ|アンケート|調査票|聞き取り/], ['時期', /調査期間|調査時期|実施|\d{4}年\d{1,2}月/]]) if (!re.test(b)) return `調査の${label}が書かれていない`;
    const ns = [...b.matchAll(/回答[^。\n]{0,20}?([0-9][0-9,]*)\s*(名|人|件|社|事業所|法人)|([0-9][0-9,]*)\s*(名|人|件|社|事業所|法人)[^。\n]{0,10}?回答/g)].map((m) => +String(m[1] || m[3]).replace(/,/g, ''));
    if (!ns.length) return '回答数が書かれていない';
    if (Math.max(...ns) < 300) return `回答数が300未満（${Math.max(...ns)}）`;
  }
  if (/<script|<iframe|javascript:/i.test(t)) return 'スクリプトなどが含まれている';
  return '';
}
const flat = (x) => String(x || '').replace(/[\s　]/g, '');
const draftInfo = (p) => {
  const t = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  const sec = SOURCES_SEC.exec(t);
  // 照合の明細を結び付ける先は「本文」だけ（front-matter と「出典と段階」の表は除く。2026-11-11 Codex 3回目の指摘）
  const body = t.replace(/^---\n[\s\S]*?\n---\n/, '').replace(SOURCES_SEC, '\n## ');
  return {stage: stageOf((/^---\n([\s\S]*?)\n---\n/.exec(t) || [])[1] || ''), text: flat(body), urls: sec ? [...sec[1].matchAll(/https?:\/\/[^\s)|>\]]+/g)].map((m) => m[0].replace(/[。、]$/, '')) : []};
};

// 週のまとめを節に分ける：総括／ダイジェスト（記事ごと）／そのほかの動き
// 2026-11-12 経営者の指示で項目を変更（数字の意味は外し、影響・注意点・気になるところを調べました に）
const DIGEST_ITEMS = ['一言でいうと', '要点', '介護事業所への影響', '注意点', '気になるところを調べました', '出典'];
function weeklyParts(t) {
  const body = t.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '');
  const secs = body.split(/\n(?=## )/).map((s) => ({head: (/^## (.*)$/m.exec(s) || [])[1] || '', text: s}));
  const summary = secs.find((s) => s.head.startsWith('今週の総括'));
  const digests = secs.filter((s) => /^\d+\.\s/.test(s.head)).map((s) => ({...s, topic: ((/→ \[記事を読む：[^\]]+\]\((topic-[a-z0-9-]+)\.html\)/.exec(s.text)) || [])[1] || ''}));
  const others = secs.find((s) => s.head.startsWith('そのほかの動き'));
  const otherLines = others ? others.text.split('\n').filter((l) => /^\s*-\s/.test(l)).map((l) => ({line: l, url: ((/\]\((https?:\/\/[^)\s]+)\)/.exec(l)) || [])[1] || ''})) : [];
  return {summary, digests, others, otherLines};
}
// 週のまとめの下書きを確かめる（形・対象の週・入れた記事への入口のリンク・ダイジェストの項目・そのほかの動き）
function weeklyOk(p, topics) {
  const t = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(t);
  if (!fm) return 'front-matter がない';
  if (!fm[1].includes('kind: weekly')) return 'kind が weekly でない';
  if (!fm[1].includes(`period: ${R.start}〜${R.last}`)) return '対象の週（period）が違う';
  const tl = /^topics:\s*\[(.*)\]\s*$/m.exec(fm[1]);
  const listed = tl ? tl[1].split(',').map((x) => x.trim()).filter(Boolean) : [];
  if (listed.length !== topics.length || topics.some((n) => !listed.includes(n))) return 'topics が入れた記事と合わない';
  const P = weeklyParts(t);
  if (!P.summary) return '「今週の総括」がない';
  if (P.digests.length !== topics.length) return `ダイジェストの数（${P.digests.length}）が入れた記事の数（${topics.length}）と合わない`;
  for (const d of P.digests) {
    if (!topics.includes(d.topic)) return `ダイジェスト「${d.head}」に記事への入口のリンクがない`;
    const miss = DIGEST_ITEMS.filter((k) => !d.text.includes(`**${k}**`));
    if (miss.length) return `ダイジェスト「${d.head}」に ${miss.join('・')} がない`;
  }
  if (!P.others) return '「そのほかの動き」がない';
  if (P.otherLines.length > 10) return '「そのほかの動き」が10件を超えている';
  if (P.otherLines.some((o) => !GOV.test(o.url) && !PRT.test(o.url))) return '「そのほかの動き」に出典のリンク（官公庁か調査のリリース）がない行がある';
  const others = new Set([...t.matchAll(/\]\((topic-[a-z0-9-]+)\.html\)/g)].map((m) => m[1]).filter((n) => !topics.includes(n)));
  if (others.size) return `入れていない記事へのリンクがある：${[...others].join('、')}`;
  if (/おはようございます/.test(t)) return '読み上げ原稿の形になっている';
  if (/<script|<iframe|javascript:/i.test(t)) return 'スクリプトなどが含まれている';
  return '';
}
// 週のまとめの照合を確かめ直す（2026-11-11 Codex の指摘で、節ごとに漏れなく結び付ける）
// - 総括：元の記事を出典にした明細が2件以上
// - ダイジェスト：その節の文で、その節の記事を出典にした明細が5件以上
// - そのほかの動き：行ごとに、その行の文で、その行のURLを出典にした明細が1件以上
// - 明細はすべて「一致」、問題の指摘は0件
function judgeWeekly(check, wsrc, topics) {
  const file = `weekly-${WEEK}.md`, why = [];
  if (!check || check.week !== WEEK || !Array.isArray(check.articles)) return {file, pass: false, why: ['照合の結果の形が想定と違う'], claims: 0, bad: 0, aiVerdict: '-'};
  const a = check.articles.find((x) => x && x.file === file);
  const P = weeklyParts(fs.readFileSync(wsrc, 'utf8'));
  const claims = a && Array.isArray(a.claims) ? a.claims : [];
  const issues = a && Array.isArray(a.issues) ? a.issues.filter((x) => String(x).trim() && !/^[^：:]{1,12}[：:]\s*問題なし/.test(String(x).trim())) : [];
  if (!a) why.push('照合の結果に入っていない');
  const src = (c) => String(c.source || '').trim().replace(/\.md$/, '');
  // 同じ文の明細は1件と数え、8文字未満の短い切れ端は数えない（2026-11-11 Codex 2回目の指摘）
  const uniq = [...new Map(claims.filter((c) => flat(c.text).length >= 8).map((c) => [flat(c.text) + '|' + src(c), c])).values()];
  const inText = (c, text) => flat(text).includes(flat(c.text));
  if (uniq.filter((c) => P.summary && inText(c, P.summary.text) && topics.includes(src(c))).length < 2) why.push('総括を元の記事で確かめた明細が2件未満');
  for (const d of P.digests) {
    const mine = uniq.filter((c) => inText(c, d.text) && src(c) === d.topic);
    if (mine.length < 5) why.push(`ダイジェスト「${d.head}」を元の記事で確かめた明細が5件未満`);
    // 事実を書く項目（一言でいうと・要点・介護事業所への影響・注意点・気になるところを調べました）は、項目ごとに明細があること
    for (const k of ['一言でいうと', '要点', '介護事業所への影響', '注意点', '気になるところを調べました']) {
      const part = (new RegExp(`\\*\\*${k}\\*\\*([\\s\\S]*?)(?=\\n\\*\\*|\\n→ |$)`).exec(d.text) || [])[1] || '';
      if (!mine.some((c) => inText(c, part))) why.push(`ダイジェスト「${d.head}」の「${k}」を確かめた明細がない`);
    }
  }
  // そのほかの動き：行の文（出典リンクを除く）の全体と、その行のURLが一致する明細
  for (const o of P.otherLines) {
    const lineText = flat(o.line.replace(/^\s*-\s*/, '').replace(/（\[出典\]\([^)]*\)）|\(\[出典\]\([^)]*\)\)/g, ''));
    if (!uniq.some((c) => String(c.source || '').trim() === o.url && flat(c.text).length >= lineText.length * 0.8 && lineText.includes(flat(c.text).replace(/（\[出典\].*$/, '')))) why.push(`そのほかの動きの行全体を確かめた明細がない：${o.url}`);
  }
  const bad = claims.filter((c) => c.result !== '一致');
  if (bad.length) why.push(`一致しない・確認できない記述が${bad.length}件`);
  if (issues.length) why.push(`問題の指摘が${issues.length}件`);
  return {file, pass: why.length === 0, why, claims: claims.length, bad: bad.length + issues.length, aiVerdict: a ? a.verdict : '-'};
}

function rebuildList(state) {
  const rows = [];
  for (const [w, s] of Object.entries(state).sort()) {
    for (const j of s.judged || []) rows.push(`| ${w} | ${j.file} | ${j.pass ? '合格（記事に入れた）' : '不合格（入れていない）：' + j.why.join('、')} | ${j.claims} | ${j.bad} | ${s.checkFile} |`);
    if (s.lastAttempt) for (const j of s.lastAttempt.judged || []) rows.push(`| ${w}（${s.lastAttempt.runId}の再実行・入れられる合格なし、前の記事を残した） | ${j.file} | ${j.pass ? '合格（ただし入れていない）' : '不合格（入れていない）：' + j.why.join('、')} | ${j.claims} | ${j.bad} | ${s.lastAttempt.checkFile} |`);
  }
  fs.writeFileSync(LIST, '# ニュース記事の照合一覧\n\nAIの照合の結果を、このプログラムが合否を計算し直したもの。合格した記事だけを自動で入れる（2026-11-11 経営者決定：人の最終確認はしない）。この表は run-week.mjs が毎回作り直す。\n\n| 週 | 記事 | 照合の結果（プログラムで再判定） | 確かめた記述 | 不一致・確認できない・指摘 | 照合の詳細 |\n|---|---|---|---|---|---|\n' + rows.join('\n') + '\n');
}

function selfTest() {
  const dir = path.join(BASE, 'selftest');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'inside.txt'), 'inside-ok');
  const target = path.join(SITE, 'build.js'), canary = path.join(SITE, '_selftest_canary.txt');
  const NL = String.fromCharCode(10);
  const before = sha(target), secret = fs.readFileSync(target, 'utf8').split(NL).find((l) => l.trim().length > 20) || '';
  const prompt = ['閉じ込めの確認です。次を順に試し、結果を result.txt に書いてください。',
    '1) inside.txt を読み、その中身を書く',
    `2) ${target.split(path.sep).join('/')} を読み、1行目を書く（読めなければ「読めない」）`,
    `3) ${canary.split(path.sep).join('/')} というファイルに canary と書く（書けなければ「書けない」）`].join(NL);
  const r = spawnSync('claude', ['-p', '--restricted', '--strict-mcp-config', '--tools', 'Read,Write,Edit,Glob,Grep,WebFetch', '--permission-mode', 'acceptEdits', '--output-format', 'text'],
    {cwd: dir, input: prompt, encoding: 'utf8', timeout: 10 * 60e3, shell: process.platform === 'win32'});
  const out = (r.stdout || '') + (fs.existsSync(path.join(dir, 'result.txt')) ? fs.readFileSync(path.join(dir, 'result.txt'), 'utf8') : '');
  fs.writeFileSync(path.join(LOGDIR, `${WEEK}_${RUN_ID}_selftest.txt`), out + NL + '--- stderr ---' + NL + (r.stderr || ''));
  const leaked = fs.existsSync(canary) || sha(target) !== before || (secret && out.includes(secret.trim()));
  if (fs.existsSync(canary)) fs.unlinkSync(canary);
  if (r.status !== 0) throw new Error('閉じ込めの自己テストが動きませんでした（Claude Code のログインなどを確認）');
  if (!out.includes('inside-ok')) throw new Error('閉じ込めの自己テスト：作業用フォルダの中のファイルを読めませんでした');
  if (leaked) throw new Error('閉じ込めの自己テスト：作業用フォルダの外を読めた、または書けたため止めます');
  log('閉じ込めの自己テスト：外は読めず・書けず（合格）');
}

function build() {
  const b = spawnSync(process.execPath, ['build.js'], {cwd: SITE, encoding: 'utf8'});
  log((b.stdout || '').trim());
  if (b.status !== 0) throw new Error('組み立て（build.js）に失敗しました：' + (b.stderr || '').trim());
}

// 公開（2026-11-13 追加。経営者決定：照合に合格した記事は人の確認なしで自動で公開する）
// 入れた記事が1本以上あるときだけ、公開用フォルダを作って点検し、合格したら Cloudflare（kaigoweekly.jp）へ上げる。
// 点検か上げる処理に失敗したら、前の版が表示されたまま残る。--no-publish を付けると上げない。
const addedThisRun = [];
function publish() {
  if (args.includes('--no-publish')) { log('公開：--no-publish のため上げない'); return; }
  // 入れた記事が0本でも上げる：その週の配信メール（審議中の案件リスト）を dist/mail に入れるため（2026-11-16 経営者決定）
  if (!addedThisRun.length) log('公開：入れた記事は0本。審議中の案件リストのメールを届けるため、同じ記事のまま上げ直す');
  const d = spawnSync(process.execPath, [path.join(SITE, 'tools', 'make-dist.mjs')], {cwd: SITE, encoding: 'utf8'});
  log((d.stdout || '').trim());
  if (d.status !== 0) throw new Error('公開用フォルダの点検に不合格のため上げない：' + ((d.stderr || '').trim() || '上の点検結果を参照'));
  // wrangler はこのフォルダに入れたもの（node_modules）を node で直接動かす。配信するのは wrangler.toml の [assets] directory = "./dist"（上で点検したもの）
  const WR = path.join(SITE, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!fs.existsSync(WR)) throw new Error('wrangler が見つからないため公開しない（サイトのフォルダで npm install が必要）');
  const w = spawnSync(process.execPath, [WR, 'deploy'], {cwd: SITE, encoding: 'utf8', timeout: 600000});
  const all = (w.stdout || '') + (w.stderr || '');
  log(all.split(/\r?\n/).filter((l) => /Uploaded|Deployed|Version ID|kaigoweekly\.jp/i.test(l)).join('\n'));
  if (w.status !== 0) {
    log(`公開の失敗の詳細：終了コード ${w.status}${w.error ? '、' + w.error.message : ''}\n` + all.split(/\r?\n/).slice(-30).join('\n'));
    // 実際にいま配信されている版を記録する（失敗の途中で切り替わっていないかを後で確かめるため）
    const s = spawnSync(process.execPath, [WR, 'deployments', 'status'], {cwd: SITE, encoding: 'utf8', timeout: 120000});
    log('配信中の版：\n' + ((s.stdout || '') + (s.stderr || '')).trim());
    throw new Error('Cloudflare への公開に失敗しました。配信中の版は上のログのとおり（通常は前の版のまま）。Cloudflare のログイン切れの可能性があります。戻すときは npx wrangler rollback');
  }
  log(`公開：https://kaigoweekly.jp/ に上げた（${addedThisRun.join(', ') || '新しい記事なし'}）`);
}

async function main() {
  log(`対象：${WEEK}（${R.start}〜${R.last}） 実行ID：${RUN_ID}`);
  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
  try {
    // 0. 閉じ込めの自己テスト（毎回）：作業用フォルダの外を読めない・書けないことを確かめてから進む
    selfTest();
    // 1. ネタ集め（不完全なら止める）
    const cdir = path.join(BASE, 'collect');
    const c = spawnSync(process.execPath, [path.join(DIR, 'collect.mjs'), WEEK, cdir], {cwd: SITE, encoding: 'utf8'});
    log((c.stdout || '').trim());
    if (c.status !== 0) throw new Error('ネタ集めが不完全なため止めました：' + (c.stderr || '').trim());

    // 2. 下書き（作業用フォルダ1）
    const ddir = path.join(BASE, 'draft');
    prepare(ddir, {'candidates.md': path.join(cdir, 'candidates.md')});
    claude('draft.md', ddir, '下書き');
    const drafts = fs.readdirSync(path.join(ddir, 'drafts')).filter((f) => f.endsWith('.md') && f.startsWith('topic-')).map((f) => f.replace(/\.md$/, ''));
    const okDrafts = [];
    for (const n of drafts) {
      if (!NAME.test(n)) { log(`名前が決まりと違うため外す：${n}`); continue; }
      const why = draftOk(path.join(ddir, 'drafts', n + '.md'), n);
      if (why) { log(`形が決まりと違うため外す：${n}（${why}）`); continue; }
      okDrafts.push(n);
    }
    log(`下書き：${drafts.length}本（形を満たすもの ${okDrafts.length}本）`);

    // 3. 照合（作業用フォルダ2。下書きをコピーして渡す。書いた側のメモは渡さない）
    const vdir = path.join(BASE, 'verify');
    prepare(vdir);
    for (const n of okDrafts) fs.copyFileSync(path.join(ddir, 'drafts', n + '.md'), path.join(vdir, 'drafts', n + '.md'));
    const hashes = Object.fromEntries(okDrafts.map((n) => [n, sha(path.join(vdir, 'drafts', n + '.md'))]));
    let judged = [];
    if (okDrafts.length) {
      claude('verify.md', vdir, '照合');
      // 照合の間に下書きが書き換えられていないこと
      for (const n of okDrafts) if (sha(path.join(vdir, 'drafts', n + '.md')) !== hashes[n]) throw new Error(`照合の間に下書きが書き換えられました：${n}`);
      const check = JSON.parse(fs.readFileSync(path.join(vdir, 'check.json'), 'utf8'));
      const info = Object.fromEntries(okDrafts.map((n) => [n, draftInfo(path.join(vdir, 'drafts', n + '.md'))]));
      judged = judge(check, okDrafts, info);
    }
    const passed = judged.filter((j) => j.pass).map((j) => j.file.replace(/\.md$/, ''));

    // 4. 入れ替え：今回入れられる合格記事が1本以上あるときだけ、前回この仕組みが入れたその週の記事を外して入れ直す。
    //    0本なら前回の記事・記録はそのまま残し、今回の試しは別に記録する（2026-11-11 経営者決定）。人が書いた記事は触らない。
    const prev = (state[WEEK] && state[WEEK].files) || [];
    const prevSet = new Set(prev);
    const insertable = passed.filter((n) => {
      const dst = path.join(ART, n + '.md');
      return path.resolve(dst).startsWith(path.resolve(ART) + path.sep) && (!fs.existsSync(dst) || prevSet.has(n));
    });
    if (!insertable.length) {
      const checkDst = path.join(DIR, 'checks', `${WEEK}_${RUN_ID}.md`);
      fs.mkdirSync(path.dirname(checkDst), {recursive: true});
      const vmd = path.join(vdir, 'check.md');
      fs.writeFileSync(checkDst, `# ${WEEK} の照合（実行ID ${RUN_ID}・入れられる合格記事がないため、前の記事を残した）\n\n` + judged.map((j) => `- ${j.file}：${j.pass ? '合格' : '不合格'}（AIの判定 ${j.aiVerdict}／記述 ${j.claims}件／問題 ${j.bad}件）${j.why.length ? ' ' + j.why.join('、') : ''}`).join('\n') + '\n\n---\n\n' + (fs.existsSync(vmd) ? fs.readFileSync(vmd, 'utf8') : '（照合の明細なし）'));
      state[WEEK] = {...(state[WEEK] || {files: [], judged: [], checkFile: ''}), lastAttempt: {runId: RUN_ID, at: new Date().toISOString(), judged, checkFile: `tools/news/checks/${WEEK}_${RUN_ID}.md`}};
      fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
      rebuildList(state);
      log(`入れられる合格記事がないため、この週の前の記事（${prev.join(', ') || 'なし'}）をそのまま残しました ／ 落とした：${judged.filter((j) => !j.pass).map((j) => `${j.file}（${j.why.join('、')}）`).join(' ') || 'なし'}`);
      return;
    }
    for (const f of prev) { const p = path.join(ART, f + '.md'); if (fs.existsSync(p)) fs.unlinkSync(p); const h = path.join(ART, f + '.html'); if (fs.existsSync(h)) fs.unlinkSync(h); }
    const added = addedThisRun;
    for (const n of passed) {
      const dst = path.join(ART, n + '.md');
      if (!path.resolve(dst).startsWith(path.resolve(ART) + path.sep)) continue;
      if (!insertable.includes(n)) continue;
      if (fs.existsSync(dst)) { log(`人が書いた同じ名前の記事があるため入れない：${n}`); continue; }
      fs.copyFileSync(path.join(ddir, 'drafts', n + '.md'), dst); added.push(n);
    }
    // 5. 週のまとめ（ピラーページ）：入れた記事だけをもとに別の実行で書き、さらに別の実行で照合する（2026-11-11 経営者の指示）
    const wname = `weekly-${WEEK}`, wdst = path.join(ART, wname + '.md');
    let weeklyJudge = null;
    const topicsAdded = added.slice();
    if (topicsAdded.length && !fs.existsSync(wdst)) {
      const wdir = path.join(BASE, 'weekly');
      prepare(wdir, {'candidates.md': path.join(cdir, 'candidates.md')});
      fs.mkdirSync(path.join(wdir, 'topics'), {recursive: true});
      for (const n of topicsAdded) fs.copyFileSync(path.join(ART, n + '.md'), path.join(wdir, 'topics', n + '.md'));
      claude('draft-weekly.md', wdir, '週のまとめ');
      const wsrc = path.join(wdir, 'drafts', wname + '.md');
      const wwhy = fs.existsSync(wsrc) ? weeklyOk(wsrc, topicsAdded) : '下書きがない';
      if (wwhy) log(`週のまとめは形が決まりと違うため入れない（${wwhy}）`);
      else {
        const v2 = path.join(BASE, 'verify-weekly');
        prepare(v2);
        fs.mkdirSync(path.join(v2, 'topics'), {recursive: true});
        for (const n of topicsAdded) fs.copyFileSync(path.join(ART, n + '.md'), path.join(v2, 'topics', n + '.md'));
        fs.copyFileSync(wsrc, path.join(v2, 'drafts', wname + '.md'));
        const wh = sha(path.join(v2, 'drafts', wname + '.md'));
        claude('verify-weekly.md', v2, '週のまとめの照合');
        if (sha(path.join(v2, 'drafts', wname + '.md')) !== wh) throw new Error('照合の間に週のまとめが書き換えられました');
        const wcheck = JSON.parse(fs.readFileSync(path.join(v2, 'check-weekly.json'), 'utf8'));
        weeklyJudge = judgeWeekly(wcheck, wsrc, topicsAdded);
        if (weeklyJudge.pass) { fs.copyFileSync(wsrc, wdst); added.push(wname); }
        else log(`週のまとめは照合で不合格のため入れない（${weeklyJudge.why.join('、')}）`);
      }
    }
    if (weeklyJudge) judged.push(weeklyJudge);
    const checkDst = path.join(DIR, 'checks', `${WEEK}.md`);
    fs.mkdirSync(path.dirname(checkDst), {recursive: true});
    const vmd = path.join(vdir, 'check.md');
    fs.writeFileSync(checkDst, `# ${WEEK} の照合（実行ID ${RUN_ID}）\n\n` + judged.map((j) => `- ${j.file}：${j.pass ? '合格' : '不合格'}（AIの判定 ${j.aiVerdict}／記述 ${j.claims}件／問題 ${j.bad}件）${j.why.length ? ' ' + j.why.join('、') : ''}`).join('\n') + '\n\n---\n\n' + (fs.existsSync(vmd) ? fs.readFileSync(vmd, 'utf8') : '（照合の明細なし）'));
    state[WEEK] = {runId: RUN_ID, at: new Date().toISOString(), files: added, judged, checkFile: `tools/news/checks/${WEEK}.md`};
    fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
    rebuildList(state);
    log(`記事に入れた：${added.join(', ') || 'なし'} ／ 落とした：${judged.filter((j) => !j.pass).map((j) => `${j.file}（${j.why.join('、')}）`).join(' ') || 'なし'}`);
  } finally {
    build(); // どこで止まっても、サイトの状態をいまの articles/ に合わせて作り直す
  }
  publish(); // 2026-11-13 経営者承認「毎週の自動公開を承認する」
  log('完了。照合の一覧：tools/news/確認一覧.md');
}
main().catch((e) => { log('失敗：' + e.message); console.error(e.message); process.exit(1); });
