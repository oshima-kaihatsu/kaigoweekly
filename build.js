// articles/*.md から記事ページ（articles/*.html）を作り、一覧を index.html に書き込む。
// 使い方: node build.js   （外部ライブラリなし。試作用の簡易Markdown変換）
// 種類（冒頭の kind）: topic＝1話題1ページ / weekly＝週次リンク集 / guide＝解説 / page＝運営者・編集方針など
const fs = require('fs');
const path = require('path');

const root = __dirname;
const dir = path.join(root, 'articles');
const SITE = 'KAIGO WEEKLY';
// 本番のURL（例：https://example.jp/）。決まったら入れる。空のうちは構造化データのURLは相対パスのまま
const SITE_URL = 'https://kaigoweekly.jp/';
const abs = p => SITE_URL ? new URL('articles/' + p, SITE_URL).href : p;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\s][^*]*)\*/g, '<em>$1</em>');
  // リンク先は http(s) と相対パスだけ許す（javascript: などはリンクにせず文字のまま残す）
  // esc 済みの文字列に対して動く。リンク先は引用符・山かっこ・& を含まないものだけ許す（2026-11-12 Codex の指摘で強化）
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) =>
    (!/["'<>&]/.test(url) && (/^https?:\/\//i.test(url) || !/^[a-z][\w+.-]*:/i.test(url))) ? `<a href="${url}" rel="noopener">${text}</a>` : m);
  s = s.replace(/(^|[\s（(])(https?:\/\/[^\s<）)]+)/g, '$1<a href="$2" rel="noopener">$2</a>');
  return s;
}

function parseFront(src) {
  const meta = {};
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return { meta, body: src };
  m[1].split(/\r?\n/).forEach(line => {
    const i = line.indexOf(':');
    if (i < 0) return;
    const k = line.slice(0, i).trim();
    // 値の後ろの「  （説明）」だけを注記として外す（値の途中の空白は残す）
    let v = line.slice(i + 1).replace(/\s{2,}（[^）]*）\s*$/, '').trim().replace(/^["']|["']$/g, '');
    if (v.startsWith('[')) v = v.replace(/^\[|\]$/g, '').split(',').map(t => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    meta[k] = v;
  });
  return { meta, body: src.slice(m[0].length) };
}

// 箇条書き（入れ子あり）。同じ深さで種類（・／番号）が変わるところで、別のリストに分ける
function mdList(lines, i) {
  const item = (l) => /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(l);
  const depth = (l) => item(l)[1].replace(/\t/g, '  ').length;
  const base = depth(lines[i]), ordered = /^\s*\d+\./.test(lines[i]);
  const items = [];
  while (i < lines.length && item(lines[i])) {
    const d = depth(lines[i]);
    if (d < base) break;
    if (d > base) {
      // 前の項目の子
      const r = mdList(lines, i);
      if (items.length) items[items.length - 1] += r.html; else items.push(r.html);
      i = r.i; continue;
    }
    if (/^\s*\d+\./.test(lines[i]) !== ordered) break;
    const text = item(lines[i])[3];
    const task = text.match(/^\[( |x)\]\s+(.*)$/i);
    items.push(task ? `<label class="task"><input type="checkbox"${task[1] !== ' ' ? ' checked' : ''}> <span>${inline(task[2])}</span></label>` : inline(text));
    i++;
  }
  const tag = ordered ? 'ol' : 'ul';
  return { html: `<${tag}>` + items.map(t => `<li>${t}</li>`).join('') + `</${tag}>`, i };
}

function md(body) {
  const lines = body.split(/\r?\n/);
  const out = [];
  let i = 0;
  const isList = l => /^\s*([-*]|\d+\.)\s+/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const n = Math.min(h[1].length + 1, 4);
      const cls = /^要点/.test(h[2]) ? ' class="points-h"' : '';
      out.push(`<h${n}${cls}>${inline(h[2])}</h${n}>`); i++; continue;
    }
    if (/^\s*---\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (line.startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith('>')) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>${buf.map(inline).join('<br>')}</blockquote>`);
      continue;
    }
    if (line.trim().startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(lines[i].trim()); i++; }
      const cells = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(rows[0]);
      const bodyRows = rows.slice(/^\|?\s*:?-{2,}/.test(rows[1] || '') ? 2 : 1);
      out.push('<div class="tbl"><table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        bodyRows.map(r => '<tr>' + cells(r).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    if (isList(line)) {
      // 箇条書き：字下げの深さで入れ子にする（2026-11-12 経営者の指摘で修正。以前は入れ子を平らにしていたため、
      // 子の項目にも親と同じ中黒が付き、文字の左端だけがずれて見えていた）
      const r = mdList(lines, i);
      out.push(r.html); i = r.i;
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|>|\||\s*---\s*$)/.test(lines[i]) && !isList(lines[i])) { buf.push(lines[i]); i++; }
    out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
  }
  return out.join('\n');
}

const KIND_LABEL = { topic: 'ニュース', weekly: '1週間まとめ', guide: '解説', page: '' };

// タグの表記ゆれをそろえる。値が null のタグは、種類・段階・全記事共通と重なるので外す
const TAG_ALIAS = {
  '認知症グループホーム': '認知症GH', 'GH': '認知症GH', 'グループホーム': '認知症GH',
  '通所介護': '通所', 'デイサービス': '通所',
  '賃上げ': '賃金', '給与': '賃金',
  '助成金': '補助金',
  '離職対策': '定着・離職', '離職率': '定着・離職', '定着': '定着・離職',
  'ハラスメント': 'カスハラ',
  'ケアマネジャー': 'ケアマネ',
  '介護': null, '採用': null, '統計': null, '調査': null, '解説': null, '週次まとめ': null, '1週間まとめ': null, 'ニュース': null,
};
function normalizeTags(list) {
  const out = [];
  list.forEach(t => {
    const v = Object.prototype.hasOwnProperty.call(TAG_ALIAS, t) ? TAG_ALIAS[t] : t;
    if (v && !out.includes(v)) out.push(v);
  });
  return out;
}

// 本文検索用のプレーンテキスト（記号を外す）。記事が数百本を超えたら検索用の索引ファイルに分ける
function plainText(body) {
  return body
    .replace(/^#{1,4}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s*([-*]|\d+\.)\s+(\[( |x)\]\s+)?/gim, '')
    .replace(/^\s*-{3,}\s*$/gm, ' ')
    .replace(/[|*`>#]+/g, ' ')
    .replace(/:?-{3,}:?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const NEWS_STAGES = ['案', '方針', '決定', '施行', '通知'];
const AUTHOR = { '@type': 'Organization', name: SITE + ' 編集部' };

// 「## 更新履歴」の中で一番新しい日付（YYYY-MM-DD）。なければ作成日
function lastModified(body, fallback) {
  const sec = body.split(/^##\s+更新履歴\s*$/m)[1] || '';
  const dates = (sec.match(/\d{4}-\d{2}-\d{2}/g) || []).sort();
  return dates.length ? dates[dates.length - 1] : fallback;
}

// 「## 出典と段階」の中のURL（一次情報の参照元として isBasedOn に入れる）
function sourceUrls(body) {
  const sec = (body.split(/^##\s+出典[^\n]*$/m)[1] || '').split(/^##\s/m)[0];
  return [...new Set(sec.match(/https?:\/\/[^\s|)）<]+/g) || [])];
}

// 週次の冒頭の一文（箇条書きの前の最初の段落）。トップの今週号の見出しに使う
function leadLine(body) {
  const l = body.split(/\r?\n/).find(x => x.trim() && !/^(#|-|\*|>|\|)/.test(x.trim()));
  return l ? l.trim() : '';
}
// 週の一覧に出す短い総括：総括の最初の1文（短すぎれば2文まで）。2026-11-12 経営者の指示（カードは記事の並びと1〜2文の総括だけ）
function weekLead(body) {
  const sents = (leadLine(body).match(/[^。]+。?/g) || []).map(s => s.trim()).filter(Boolean);
  return sents.length ? (sents[0].length < 30 && sents[1] ? sents[0] + sents[1] : sents[0]) : '';
}

const tpl = fs.readFileSync(path.join(root, 'article-template.html'), 'utf8');
// 冒頭に「publish: no」がある記事は組み立てない（一覧・リンクにも出さない。2026-11-13 補助金の解説を今回は出さない決定）
const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort()
  .filter(f => !/^publish:\s*no\s*$/m.test((fs.readFileSync(path.join(dir, f), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || ''));
const docs = files.map(f => {
  const parsed = parseFront(fs.readFileSync(path.join(dir, f), 'utf8'));
  const meta = parsed.meta;
  const slug = f.replace(/\.md$/, '');
  const kind = meta.kind || (slug.startsWith('weekly') ? 'weekly' : slug.startsWith('topic') ? 'topic' : slug.startsWith('guide') ? 'guide' : 'page');
  // 本文先頭の「# 見出し」はページの h1 と重なるので外す
  const body = parsed.body.replace(/^\s*#\s+[^\n]*\n/, '');
  const arr = v => Array.isArray(v) ? v : (v ? [v] : []);
  return {
    slug, kind, body,
    title: meta.title || slug, date: meta.date || '', period: meta.period || '',
    summary: meta.summary || '', stage: meta.stage || '',
    services: normalizeTags(arr(meta.services)), tags: normalizeTags(arr(meta.tags)), topics: arr(meta.topics), watch: arr(meta.watch),
  };
});
const bySlug = Object.fromEntries(docs.map(d => [d.slug, d]));

// 週次が指す話題がなければ、今週号が欠けるので止める
docs.filter(d => d.kind === 'weekly').forEach(d => {
  const missing = d.topics.filter(s => !bySlug[s]);
  if (missing.length) throw new Error(`${d.slug} の topics に見つからない記事があります: ${missing.join(', ')}`);
});

function cardHtml(d, prefix) {
  const badges = [d.stage && `<span class="stage">${esc(d.stage)}</span>`, ...d.services.map(s => `<span>${esc(s)}</span>`)].filter(Boolean).join('');
  return `<a class="card" href="${prefix}${d.slug}.html"><div class="meta"><span class="kind">${KIND_LABEL[d.kind] || ''}</span>` +
    (d.period ? `<span>${esc(d.period)}</span>` : '') + `</div><h3>${esc(d.title)}</h3><p>${esc(d.summary)}</p>` +
    (badges ? `<div class="tags">${badges}</div>` : '') + '</a>';
}

// 週のまとめのダイジェストを、記事ごとの見出しカードにする（2026-11-12 経営者の指示）
// ピラーページ自体がダイジェストなので、折りたたまずに全部見せる。上の目次（記事の見出しカード）から必要な記事へ飛べるようにする。
// 重要度：①一言でいうと・要点 ②どんな影響があるか・注意点 ③気になるところを調べました（補足）。
const ITEM_LABEL = /<p><strong>(介護事業所への影響|注意点|気になるところを調べました|出典)<\/strong>(：)?/g;
// 詳しい記事へのボタンの文言：その記事に実際にある節から、次の行動につながる言葉を選ぶ（2026-11-12 経営者の指示）
function deeperLabel(t) {
  const has = (re) => re.test(t.body);
  const calc = has(/^## 数字で見る/m), job = has(/^## 求人票の書き換え例/m);
  if (calc && job) return '自社の数字で差を計算し、求人票の書き換え例まで見る';
  if (calc) return '自社の数字に当てはめて計算してみる';
  if (job) return '求人票の書き換え例を見る';
  return '自分の事業所が当てはまるか、詳しく確かめる';
}
const SRC_NAME = (u) => /mhlw\.go\.jp/.test(u) ? '厚生労働省' : /cfa\.go\.jp/.test(u) ? 'こども家庭庁' : /prtimes\.jp/.test(u) ? 'PR TIMES' : '出典';
function weeklyLayout(html) {
  const parts = html.split(/(?=<h3>)/);
  const digests = [];
  const body = parts.map((p) => {
    if (/^<h3>今週の総括/.test(p)) return `<section class="wk-summary">${p}</section>`;
    if (/^<h3>そのほかの動き/.test(p)) {
      // そのほかの動き：日付・1行の内容・出典へのリンクの形で、ニュースとして読めるようにする（文は照合した行のまま）
      return p.replace(/^<h3>そのほかの動き<\/h3>\s*<ul>([\s\S]*?)<\/ul>/, (x, items) => '<section class="wk-others"><h3>そのほかの動き</h3><p class="wk-others-lead">注目の3本のほかに、この週に公表された介護に関係する動きです。</p><ul>' +
        items.replace(/<li>([\s\S]*?)（<a href="([^"]+)" rel="noopener">出典<\/a>）<\/li>/g, (y, text, url) => {
          if (!/^https:\/\/[^"'<>&\s]+$/.test(url)) return y; // 出典は https のURLだけをリンクにする
          const date = (/(\d{1,2}月\d{1,2}日)/.exec(text) || [])[1] || '';
          return `<li>${date ? `<span class="wo-date">${date}</span>` : ''}<p class="wo-text">${text}</p><a class="wo-src" href="${url}" rel="noopener">${SRC_NAME(url)}の発表を見る</a></li>`;
        }) + '</ul></section>');
    }
    const m = /^<h3>(\d+)\.\s*([\s\S]*?)<\/h3>/.exec(p);
    if (!m) return p;
    let rest = p.slice(m[0].length), more = '';
    rest = rest.replace(/<p class="readmore">[\s\S]*?<\/p>/, (x) => { more = x; return ''; });
    const slug = (/href="(topic-[a-z0-9-]+)\.html"/.exec(more) || [])[1];
    const t = slug && bySlug[slug];
    const badge = t && t.stage ? `<span class="digest-stage">${esc(t.stage)}</span>` : '';
    digests.push({no: m[1], title: m[2], badge});
    // 詳しい記事へのボタン：記事で得られるものを大きく、記事名を小さく
    if (t) more = `<p class="readmore deeper"><a href="${t.slug}.html"><span class="deeper-act">${esc(deeperLabel(t))} →</span><span class="deeper-t">記事：${esc(t.title)}</span></a></p>`;
    const body2 = rest
      .replace(/<p><strong>一言でいうと<\/strong>：/, '<p class="dg-one"><span class="dg-one-label">一言でいうと</span>')
      .replace(ITEM_LABEL, (x, k, colon) => `<h4 class="dg-label${k === '気になるところを調べました' ? ' dg-label-sub' : k === '出典' ? ' dg-label-src' : ''}">${k}</h4><p${k === '出典' ? ' class="dg-src"' : ''}>`)
      .replace(/<p><\/p>/g, '')
      .replace(/<li>Q：([\s\S]*?)　A：([\s\S]*?)<\/li>/g, '<li class="qa"><p class="q">$1</p><p class="a">$2</p></li>');
    return `<section class="digest" id="n${m[1]}"><div class="digest-head"><span class="digest-no">${m[1]}</span>${badge}<h3>${m[2]}</h3></div>` +
      `<div class="digest-body">${body2}</div>${more}<p class="to-top"><a href="#wk-toc">この週のニュースの一覧へ戻る</a></p></section>`;
  }).join('');
  if (!digests.length) return html;
  const toc = '<nav class="wk-toc" id="wk-toc" aria-label="この週の注目ニュース"><p class="wk-toc-h">この週の注目ニュース（' + digests.length + '本）</p><ol>' +
    digests.map((d) => `<li><a href="#n${d.no}"><span class="toc-top"><span class="digest-no">${d.no}</span>${d.badge}</span><span class="wk-toc-t">${d.title}</span></a></li>`).join('') + '</ol></nav>';
  return body.replace(/(<\/section>)/, '$1' + toc);
}

// 記事が入っている週のまとめ（ピラーページ）を引く
// サイトにない記事へのリンク（照合で落ちた同じ週の記事など）は、文字だけにする（リンク切れを出さない）
const unlinkMissing = (h) => h.replace(/<a href="((?:topic|weekly|guide)-[a-z0-9-]+)\.html"[^>]*>([\s\S]*?)<\/a>/g, (x, s, text) => bySlug[s] ? x : (console.warn('リンク先の記事がないため文字にした: ' + s), text));
const weeklyOf = Object.fromEntries(docs.filter(d => d.kind === 'weekly').flatMap(w => w.topics.map(s => [s, w])));

docs.forEach(d => {
  let extra = '';
  if (d.kind === 'weekly' && d.topics.length) {
    // 本文のダイジェストから全記事へリンクしていれば、記事カードの一覧は重ねて出さない
    const linked = d.topics.every(s => d.body.includes(`(${s}.html)`));
    if (!linked) extra = '<h2>この週のニュース</h2><div class="cards">' + d.topics.map(s => bySlug[s] ? cardHtml(bySlug[s], '') : `<p class="small">（${esc(s)} が見つかりません）</p>`).join('') + '</div>';
  }
  // パンくず：ホーム ＞ 週のまとめ ＞ 記事（2026-11-11 週のまとめを各記事のピラーページにした）
  const parent = d.kind === 'topic' ? weeklyOf[d.slug] : null;
  const crumbs = [['KAIGO WEEKLY', '../index.html', abs('../index.html')], ...(parent ? [[parent.title.replace(/：.*$/, ''), parent.slug + '.html', abs(parent.slug + '.html')]] : []), [d.title, '', abs(d.slug + '.html')]];
  const crumbHtml = '<nav class="crumbs" aria-label="パンくずリスト"><ol>' + crumbs.map(([n, h]) => h ? `<li><a href="${h}">${esc(n)}</a></li>` : `<li aria-current="page">${esc(n)}</li>`).join('') + '</ol></nav>';
  const crumbLd = {'@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: crumbs.map(([n, , u], i) => ({'@type': 'ListItem', position: i + 1, name: n, item: u}))};
  const backHtml = parent ? `<p class="weekly-back">この記事は「<a href="${parent.slug}.html">${esc(parent.title.replace(/：.*$/, ''))}</a>」に入っています。同じ週のほかのニュースもまとめて読めます。</p>` : '';
  // 対象とタグは、トップの検索（index.html?tag=…）へのリンクにする
  const tagLink = (t, label) => `<a class="tag" href="../index.html?tag=${encodeURIComponent(t)}#search">${esc(label)}</a>`;
  const badges = [d.stage && `<span class="stage">段階：${esc(d.stage)}</span>`, ...d.services.map(s => tagLink(s, '対象：' + s)), ...d.tags.map(t => tagLink(t, t))].filter(Boolean).join('');
  const modified = lastModified(d.body, d.date);
  const ld = d.kind === 'weekly' ? {
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name: d.title, datePublished: d.date, dateModified: modified, description: d.summary,
    mainEntity: { '@type': 'ItemList', itemListElement: d.topics.filter(s => bySlug[s]).map((s, n) => ({ '@type': 'ListItem', position: n + 1, url: abs(s + '.html'), name: bySlug[s].title })) },
    publisher: { '@type': 'Organization', name: SITE },
  } : {
    '@context': 'https://schema.org',
    '@type': d.kind === 'topic' && NEWS_STAGES.includes(d.stage) ? 'NewsArticle' : 'Article',
    headline: d.title, datePublished: d.date, dateModified: modified, description: d.summary,
    author: AUTHOR, publisher: { '@type': 'Organization', name: SITE },
    // 本番では幅1200px以上の画像を用意して image を入れる（Discoverの条件）
  };
  const based = sourceUrls(d.body);
  if (d.kind !== 'weekly' && based.length) ld.isBasedOn = based;
  const page = tpl
    .replace(/{{title}}/g, esc(d.title))
    .replace(/{{description}}/g, esc(d.summary))
    .replace(/{{date}}/g, esc(d.date))
    .replace(/{{period}}/g, d.period ? `<span>対象期間：${esc(d.period)}</span>` : '')
    .replace(/{{kind}}/g, KIND_LABEL[d.kind] || '')
    .replace(/{{kindclass}}/g, d.kind)
    .replace(/{{tags}}/g, badges)
    .replace('{{jsonld}}', d.kind === 'page' ? '' : `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script><script type="application/ld+json">${JSON.stringify(crumbLd).replace(/</g, '\\u003c')}</script>`)
    .replace('{{crumbs}}', () => crumbHtml)
    .replace('{{printbtn}}', d.kind === 'weekly' ? '<button class="print-btn" type="button" onclick="window.print()">印刷する（A4）</button>' : '')
    .replace('{{body}}', () => { const h = md(d.body).replace(/<p>→ (<a [^>]*>)/g, '<p class="readmore">$1'); return backHtml + unlinkMissing(d.kind === 'weekly' ? weeklyLayout(h) : h) + extra + backHtml; });
  fs.writeFileSync(path.join(dir, d.slug + '.html'), page);
});

// 1週間まとめの一覧ページ（全週）。トップには最新の数週だけを横に並べ、ここへつなぐ（2026-11-12 経営者の指示）
{
  const weeks = docs.filter(d => d.kind === 'weekly').sort((a, b) => (b.period || b.date).localeCompare(a.period || a.date));
  const wkLabel = (p) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(p || ''); return m ? `${+m[1]}年${+m[2]}月${+m[3]}日週` : ''; };
  const items = weeks.map(w => `<li><a class="wl-card" href="${w.slug}.html"><span class="wl-when">${esc(wkLabel(w.period))}のまとめ</span>` +
    `<span class="wl-lead">${esc(weekLead(w.body) || w.title)}</span>` +
    `<span class="wl-titles">${w.topics.filter(s => bySlug[s]).map(s => `<span>${esc(bySlug[s].title.split('：')[0])}</span>`).join('')}</span></a></li>`).join('');
  const title = '1週間まとめの一覧';
  const crumbs = '<nav class="crumbs" aria-label="パンくずリスト"><ol><li><a href="../index.html">KAIGO WEEKLY</a></li><li aria-current="page">' + title + '</li></ol></nav>';
  const page = tpl
    .replace(/{{title}}/g, title).replace(/{{description}}/g, 'KAIGO WEEKLYの1週間まとめを、新しい週から順に並べた一覧です。')
    .replace(/{{date}}/g, weeks[0] ? esc(weeks[0].date) : '').replace(/{{period}}/g, '').replace(/{{kind}}/g, '1週間まとめ').replace(/{{kindclass}}/g, 'weekly')
    .replace(/{{tags}}/g, '').replace('{{jsonld}}', '').replace('{{crumbs}}', () => crumbs).replace('{{printbtn}}', '')
    .replace('{{body}}', () => `<p>毎週月曜に、前の週の介護ニュースをまとめています。新しい週から順に並べています（全${weeks.length}週）。</p><ul class="wl-list">${items}</ul>`);
  fs.writeFileSync(path.join(dir, 'weekly-list.html'), page);
}

// 一覧は index.html に直接書き込む（file:// でも外部JSを読まずに表示できるように）
const list = docs.filter(d => d.kind !== 'page').map(d => ({
  kind: d.kind, file: 'articles/' + d.slug + '.html', title: d.title, date: d.date, period: d.period,
  summary: d.summary, stage: d.stage, services: d.services, tags: d.tags.filter(t => !d.services.includes(t)),
  text: plainText(d.body),
  ...(d.kind === 'weekly' ? { topics: d.topics, watch: d.watch.filter(s => bySlug[s]), lead: weekLead(d.body), topicTitles: d.topics.filter(s => bySlug[s]).map(s => bySlug[s].title.split('：')[0]) } : {}),
}));
list.sort((a, b) => (b.period || b.date).localeCompare(a.period || a.date) || a.title.localeCompare(b.title));
const indexPath = path.join(root, 'index.html');
const json = JSON.stringify(list).replace(/</g, '\\u003c');
const index = fs.readFileSync(indexPath, 'utf8').replace(
  /<!--ARTICLES-->[\s\S]*?<!--\/ARTICLES-->/,
  () => `<!--ARTICLES--><script>window.ARTICLES = ${json};</script><!--/ARTICLES-->`
);
fs.writeFileSync(indexPath, index);
console.log(`built ${docs.length} pages (topic ${docs.filter(d => d.kind === 'topic').length}, weekly ${docs.filter(d => d.kind === 'weekly').length}, guide ${docs.filter(d => d.kind === 'guide').length}, page ${docs.filter(d => d.kind === 'page').length})`);
