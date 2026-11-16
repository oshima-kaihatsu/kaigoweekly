// collect.mjs — 1週間分（月曜〜日曜）のニュースの候補を集める。外部ライブラリなし（Node 18+ の fetch）。
// 使い方: node tools/news/collect.mjs 2026-W45
// 出力: tools/news/work/<週>/candidates.json と candidates.md
//
// 情報源と使い方（2026-11-11 に各サイトの利用条件を確認。_design/20261111_ニュース更新の仕組み.md）
// - 厚労省 報道発表（月別一覧）・介護給付費分科会：公共データ利用規約1.0。要約＋出典URL＋加工した旨の記載で利用できる（一次情報）
// - こども家庭庁 新着：公共データ利用規約1.0。同上（一次情報）
// - PR TIMES：企業・団体の調査リリースだけを対象にする（2026-11-11 経営者決定。出典＝リリースのURL、調査した会社・時期・回答数・方法を必ず書く）。
//   検索（keyword_search API）で「介護 調査」「介護 アンケート」を週1回取得し、題名で介護・福祉かつ調査・アンケート・白書などに当たるものに絞る。宣伝だけのものは下書きの段階で落とす。
// 介護ニュースJoint（API の自動取得の可否が未確認）は、自動では集めない（2026-11-11 Codex の指摘）。
// 取得に失敗した・ページの作りが想定と違う・件数の上限に当たった場合は「不完全」として終了コード3で止める（下書きに進ませない）。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (kaigoweekly-news-collector; weekly, low volume)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ISO週（例 2026-W45）→ 月曜0時〜翌月曜0時（日本時間）
export function weeksInYear(y) {
  const d = new Date(Date.UTC(y, 11, 28)); // 12/28 は必ずその年の最後のISO週に入る
  const t = new Date(d); t.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const jan4 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
}
export function weekRange(w) {
  const m = /^(\d{4})-W(\d{2})$/.exec(w);
  if (!m) throw new Error('週は 2026-W45 の形で指定してください');
  const y = +m[1], n = +m[2];
  if (n < 1 || n > weeksInYear(y)) throw new Error(`${y}年に${n}週目はありません`);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const mon1 = new Date(jan4); mon1.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const start = new Date(mon1); start.setUTCDate(mon1.getUTCDate() + (n - 1) * 7);
  const end = new Date(start); end.setUTCDate(start.getUTCDate() + 7);
  const ymd = (d) => d.toISOString().slice(0, 10);
  const last = new Date(end); last.setUTCDate(end.getUTCDate() - 1);
  return {start: ymd(start), end: ymd(end), last: ymd(last)};
}
const inRange = (d, r) => d >= r.start && d < r.end;
const strip = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&#8211;/g, '–').replace(/&#8212;/g, '—').replace(/&#82(16|17);/g, "'").replace(/&#82(20|21);/g, '"').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {headers: {'user-agent': UA}, signal: AbortSignal.timeout(30000)});
      if (res.ok) return await res.text();
      if (res.status === 404) return null;
      throw new Error('HTTP ' + res.status);
    } catch (e) {
      if (i === 2) throw new Error(`${url}: ${e.message}`);
      await sleep(3000 * (i + 1));
    }
  }
}

// 厚労省 報道発表（月別一覧）。「YYYY年M月D日（曜）掲載」の見出しの下に li が並ぶ
async function mhlwPress(r) {
  const months = [...new Set([r.start, r.last].map((d) => d.slice(0, 7).replace('-', '')))];
  const out = [];
  for (const ym of months) {
    const html = await get(`https://www.mhlw.go.jp/stf/houdou/houdou_list_${ym}.html`);
    if (!html) throw new Error(`報道発表の${ym}の一覧が見つかりません`);
    const parts = html.split(/<h3 class="m-hdgLv3__hdg">/).slice(1);
    if (!parts.length || !html.includes('m-listNews')) throw new Error(`報道発表の${ym}の一覧の作りが想定と違います`);
    for (const p of parts) {
      const dm = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(p);
      if (!dm) continue;
      const date = `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`;
      if (!inRange(date, r)) continue;
      const ul = p.split('</ul>')[0];
      for (const m of ul.matchAll(/<a href="([^"]+)">[\s\S]*?<span>([\s\S]*?)<\/span>/g)) {
        out.push({source: '厚労省 報道発表', primary: true, date, title: strip(m[2]), url: new URL(m[1], 'https://www.mhlw.go.jp').href});
      }
    }
    await sleep(1500);
  }
  return out;
}

// 厚労省 介護給付費分科会（直近の開催内容の表）
async function mhlwKaigoKyufu(r) {
  const html = await get('https://www.mhlw.go.jp/stf/shingi/shingi-hosho_126698_00022.html');
  if (!html) throw new Error('介護給付費分科会のページが見つかりません');
  const out = [];
  const rows = html.split('<tr>').slice(1);
  if (!rows.some((row) => /第\d+回/.test(row) && /\d{4}年\d{1,2}月\d{1,2}日/.test(row))) throw new Error('介護給付費分科会の表の作りが想定と違います');
  for (const row of rows) {
    const no = /第(\d+)回/.exec(row), dm = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(row);
    if (!no || !dm) continue;
    const date = `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`;
    if (!inRange(date, r)) continue;
    const tds = row.split('</td>').map(strip);
    const agenda = tds.find((t) => t.length > 8 && !/^第\d+回$/.test(t) && !/年\d+月/.test(t)) || '';
    const shiryo = /<a class="m-link" href="([^"]+)">資料<\/a>/.exec(row);
    out.push({source: '厚労省 介護給付費分科会', primary: true, date, title: `第${no[1]}回 社会保障審議会介護給付費分科会：${agenda}`.slice(0, 200),
      url: shiryo ? new URL(shiryo[1], 'https://www.mhlw.go.jp').href : 'https://www.mhlw.go.jp/stf/shingi/shingi-hosho_126698_00022.html'});
  }
  return out;
}

// こども家庭庁 新着（/news?page=N）。カードに日付・分類・題名がある
async function cfaNews(r) {
  const out = [];
  let reached = false;
  for (let page = 0; page < 10; page++) {
    const html = await get(`https://www.cfa.go.jp/news${page ? '?page=' + page : ''}`);
    if (!html) throw new Error(`新着の${page + 1}ページ目が見つかりません`);
    if (!html.includes('<section class="card">')) throw new Error('新着の作りが想定と違います');
    let older = false;
    for (const c of html.split('<section class="card">').slice(1)) {
      const href = /href="([^"]+)"/.exec(c), date = /<time datetime="(\d{4}-\d{2}-\d{2})"/.exec(c);
      const cat = /card__category">\s*([\s\S]*?)\s*<\/span>/.exec(c), title = /card__title">[\s\S]*?<span>([\s\S]*?)<\/span>/.exec(c);
      if (!href || !date || !title) continue;
      if (date[1] < r.start) { older = true; continue; }
      if (!inRange(date[1], r)) continue;
      out.push({source: 'こども家庭庁 ' + (cat ? strip(cat[1]) : '新着'), primary: true, date: date[1], title: strip(title[1]), url: new URL(href[1], 'https://www.cfa.go.jp').href});
    }
    if (older) { reached = true; break; }
    await sleep(1500);
  }
  if (!reached) throw new Error('新着を10ページ見ても週の始まりまで届きませんでした（取りこぼしの可能性）');
  return out;
}

// PR TIMES の調査リリース（keyword_search API）。released_at は「N時間前」「N分前」か「YYYY年M月D日 HH時MM分」
function prDate(s) {
  const m = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const rel = /(\d+)\s*(分|時間|日)前/.exec(s);
  if (!rel) return null;
  const ms = {分: 60e3, 時間: 3600e3, 日: 864e5}[rel[2]] * +rel[1];
  return new Date(Date.now() + 9 * 3600e3 - ms).toISOString().slice(0, 10); // 日本時間の日付
}
async function prtimes(r) {
  const out = [], seen = new Set();
  const care = /介護|福祉|ケア|高齢者|ヘルパー|看護|特養|デイサービス|老人ホーム/;
  const survey = /調査|アンケート|白書|実態|意識|割|％|%|ランキング|レポート/;
  for (const kw of ['介護 調査', '介護 アンケート', '介護職 採用', '介護 人材']) {
    let reached = false;
    for (let page = 1; page <= 20; page++) {
      const txt = await get(`https://prtimes.jp/api/keyword_search.php/search?keyword=${encodeURIComponent(kw)}&page=${page}&limit=40`);
      if (!txt) throw new Error('PR TIMES の検索が見つかりません');
      let d;
      try { d = JSON.parse(txt).data; } catch { throw new Error('PR TIMES の検索の作りが想定と違います'); }
      if (!d || !Array.isArray(d.release_list)) throw new Error('PR TIMES の検索の作りが想定と違います');
      if (!d.release_list.length) { reached = true; break; }
      // ページの全件が週の始まりより古くなるまで読む（並び順が新しい順でなくても取りこぼさないように。2026-11-11 Codex の指摘）
      let older = true;
      for (const x of d.release_list) {
        const date = prDate(String(x.released_at || ''));
        if (!date) throw new Error('PR TIMES の日付の形が想定と違います：' + x.released_at);
        if (date >= r.start) older = false;
        if (date < r.start) continue;
        if (!inRange(date, r) || seen.has(x.release_url)) continue;
        const title = strip(x.title);
        if (!care.test(title) || !survey.test(title)) continue;
        seen.add(x.release_url);
        out.push({source: 'PR TIMES（企業・団体の調査）', primary: true, date, title: `${title}（${strip(x.company_name)}）`, url: new URL(x.release_url, 'https://prtimes.jp').href});
      }
      if (older || page >= (d.last_page || 0)) { reached = true; break; }
      await sleep(1500);
    }
    if (!reached) throw new Error(`PR TIMES「${kw}」を20ページ見ても週の始まりまで届きませんでした（取りこぼしの可能性）`);
  }
  return out;
}

// 介護ニュースJoint（使っていない。運営会社の確認が取れたら使う）（WordPress公開API）。手がかりとしてだけ使う
async function joint(r) {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const url = `https://www.joint-kaigo.com/wp-json/wp/v2/posts?after=${r.start}T00:00:00&before=${r.end}T00:00:00&per_page=100&page=${page}&_fields=id,date,link,title`;
    const txt = await get(url);
    if (!txt) break;
    const arr = JSON.parse(txt);
    for (const p of arr) out.push({source: '介護ニュースJoint', primary: false, date: p.date.slice(0, 10), title: strip(p.title.rendered), url: p.link});
    if (arr.length < 100) break;
    await sleep(1500);
  }
  return out;
}

async function main() {
  const w = process.argv[2];
  const r = weekRange(w);
  const dir = process.argv[3] || path.join(DIR, 'work', w);
  fs.mkdirSync(dir, {recursive: true});
  const all = [], errors = [];
  for (const [name, fn] of [['厚労省 報道発表', mhlwPress], ['厚労省 介護給付費分科会', mhlwKaigoKyufu], ['こども家庭庁', cfaNews], ['PR TIMES 調査', prtimes]]) {
    try { const got = await fn(r); all.push(...got); console.log(`${name}: ${got.length}件`); }
    catch (e) { errors.push(`${name}: ${e.message}`); console.error(`${name}: 取得できませんでした（${e.message}）`); }
  }
  all.sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source));
  const res = {week: w, range: r, collectedAt: new Date().toISOString(), errors, items: all.map((x, i) => ({id: 'c' + String(i + 1).padStart(3, '0'), ...x}))};
  fs.writeFileSync(path.join(dir, 'candidates.json'), JSON.stringify(res, null, 1));
  const md = [`# ${w}（${r.start}〜${r.last}）の候補`, '', `集めた日時：${res.collectedAt}`, errors.length ? `\n取得できなかった情報源：${errors.join(' ／ ')}\n` : '',
    '| id | 日付 | 情報源 | 一次情報 | 題名 | URL |', '|---|---|---|---|---|---|',
    ...res.items.map((x) => `| ${x.id} | ${x.date} | ${x.source} | ${x.primary ? '○' : '手がかり'} | ${x.title.replace(/\|/g, '｜')} | ${x.url} |`)].join('\n');
  fs.writeFileSync(path.join(dir, 'candidates.md'), md + '\n');
  console.log(`合計 ${all.length}件 → ${path.relative(process.cwd(), dir)}`);
  if (errors.length) { console.error('取得が不完全なため止めます'); process.exit(3); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
