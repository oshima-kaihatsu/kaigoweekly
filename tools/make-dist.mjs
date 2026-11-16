// make-dist.mjs — 公開用フォルダ dist/ を作り、上げる前の点検をする。上げる（公開する）処理は入れていない。
// 使い方: node tools/make-dist.mjs            … dist/ を作って点検（公開前の今は noindex・試作表示で不合格になるのが正常）
//         node tools/make-dist.mjs --check-only … dist/ を作り直さず点検だけ
// 終了コード: 0=点検合格 / 1=不合格（理由を表示）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(SITE, 'dist');
const MAX_FILES = 20000;            // Cloudflare Pages 無料プラン：1サイトのファイル数
const MAX_BYTES = 25 * 1024 * 1024; // 同：1ファイル 25 MiB

const checkOnly = process.argv.includes('--check-only');
let CONFIG = {};
const CONFIG_PATH = path.join(SITE, 'tools', 'site-config.json');
if (fs.existsSync(CONFIG_PATH)) CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); // 壊れていたら止める
const SITE_ORIGIN = 'https://kaigoweekly.jp';
const NOINDEX = new Set(['articles/subscribed.html']);
// メール登録の受付：worker と同じ wrangler.toml の MAIL_SIGNUP を読む（1か所で管理）
const MAIL_MODE = (/^MAIL_SIGNUP\s*=\s*"([^"]*)"/m.exec(fs.readFileSync(path.join(SITE, 'wrangler.toml'), 'utf8')) || [])[1] || '0';
const MAIL_SIGNUP = MAIL_MODE === '1';
const MAIL_TEST = MAIL_MODE === 'test'; // 試し登録：登録欄は隠したまま、#mailtest を付けて開いたときだけ出す
// 特定電子メール法の表示（送信者の名前・住所）。運営者情報と同じ
const OPERATOR = { name: '大島健太郎', address: '〒103-0026 東京都中央区日本橋兜町17-2 兜町第6葉山ビル4F' };
if (CONFIG.ga4Id && !/^G-[A-Z0-9]{6,12}$/.test(CONFIG.ga4Id)) { console.error(`site-config.json の ga4Id の形が正しくない：${CONFIG.ga4Id}`); process.exit(1); }
const GA4 = CONFIG.ga4Id || '';
const skipped = [];

function copy(rel) {
  const dst = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(SITE, rel), dst);
}

if (!checkOnly) {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST);
  // ページ：トップと記事の html だけ（.md・テンプレート・build.js は入れない）
  copy('index.html');
  // 記事は、元の .md があり build.js が作ったもの（下書きの status でないもの）と、一覧ページだけ。それ以外の html は入れない
  for (const f of fs.readdirSync(path.join(SITE, 'articles'))) {
    if (!f.endsWith('.html')) continue;
    const md = path.join(SITE, 'articles', f.replace(/\.html$/, '.md'));
    const listed = f === 'weekly-list.html';
    if (!listed && !fs.existsSync(md)) { skipped.push(f); continue; }
    if (!listed && /^(status:\s*(下書き|非公開)|publish:\s*no)\s*$/m.test(fs.readFileSync(md, 'utf8'))) { skipped.push(f); continue; }
    copy(path.join('articles', f));
  }
  // 画像・CSS・動画：ページか CSS から参照されているものだけ
  const texts = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : texts.push(fs.readFileSync(p, 'utf8')); } };
  walk(DIST);
  const cssFiles = fs.readdirSync(path.join(SITE, 'assets')).filter((f) => f.endsWith('.css'));
  const used = (name) => texts.some((t) => t.includes(name));
  const usedCss = cssFiles.filter(used);
  const all = texts.concat(usedCss.map((f) => fs.readFileSync(path.join(SITE, 'assets', f), 'utf8')));
  for (const f of fs.readdirSync(path.join(SITE, 'assets'))) if (all.some((t) => t.includes(f))) copy(path.join('assets', f));
  // いたずら防止（Turnstile）のサイトキーを入れる。サイトキーは公開してよい値（秘密鍵ではない）
  let key = process.env.TURNSTILE_SITEKEY || '';
  if (!key) key = CONFIG.turnstileSiteKey || '';
  if (key) for (const rel of ['index.html']) {
    const p = path.join(DIST, rel);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll('__TURNSTILE_SITEKEY__', key));
  }
  // 全ページに、正規のURL（canonical）と、アクセス解析（GA4。測定IDは site-config.json の ga4Id だけで管理）を入れる。
  // 毎週の自動生成ページもここを通るので、入れ忘れが起きない。
  const pages = [];
  const walkHtml = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walkHtml(p); else if (p.endsWith('.html')) pages.push(p); } };
  walkHtml(DIST);
  for (const p of pages) {
    const rel = path.relative(DIST, p).replace(/\\/g, '/');
    const url = SITE_ORIGIN + '/' + (rel === 'index.html' ? '' : rel);
    let t = fs.readFileSync(p, 'utf8');
    t = t.replace(/<link rel="canonical"[^>]*>\n?/g, '').replace('</head>', `<link rel="canonical" href="${url}">\n</head>`);
    if (GA4) t = t.replace('</head>', gaSnippet(GA4) + '\n</head>');
    // メール登録の受付は wrangler.toml の MAIL_SIGNUP が "1" のときだけ出す（Brevo の名簿とひな形の準備が済むまでは「準備中」）
    if (MAIL_TEST && rel === 'index.html') {
      t = t.replace('<form class="mail-form" id="subscribe-form"', '<p class="point-note" id="mail-wait">メールの登録の受付は、準備中です。</p>\n        <form class="mail-form" id="subscribe-form" hidden')
        .replace('</body>', `<script>if (location.hash === '#mailtest') { var f = document.getElementById('subscribe-form'); if (f) f.hidden = false; var w = document.getElementById('mail-wait'); if (w) w.hidden = true; }</script>\n</body>`);
    } else if (!MAIL_SIGNUP && rel === 'index.html') {
      t = t.replace(/<form class="mail-form"[\s\S]*?<\/form>/, '<p class="point-note">メールの登録の受付は、準備中です。</p>');
    }
    if (!MAIL_SIGNUP && rel === 'articles/about.html') {
      t = t.replace('毎週月曜に、前の週の介護ニュースのまとめをメールでお届けします。', '毎週月曜に、前の週の介護ニュースのまとめをメールでお届けする仕組みを準備中です。');
    }
    if (!MAIL_SIGNUP && rel === 'articles/privacy.html') {
      t = t.replace('今受け付けているのは、相談フォーム、ご要望、メール登録です。', '今受け付けているのは、相談フォームとご要望です。メール登録は準備中です。');
    }
    // 登録完了のページは検索に出さない
    if (NOINDEX.has(rel)) t = t.replace('</head>', '<meta name="robots" content="noindex">\n</head>');
    // GA4 を入れていない間は、プライバシーポリシーから Google アナリティクスの説明を外す（説明と実際を合わせる）
    if (!GA4 && rel === 'articles/privacy.html') {
      t = t.replace(/<h3>アクセス解析（Google アナリティクス）<\/h3>[\s\S]*?(?=<h3>)/, '')
        .replace(/<tr><td>閲覧の記録[\s\S]*?<\/tr>/, '')
        .replace(/<tr><td>Google LLC（Google アナリティクス）[\s\S]*?<\/tr>/, '');
    }
    fs.writeFileSync(p, t);
  }
  // サイトマップと robots.txt（毎週の公開のたびに作り直す）
  const lastmod = (rel) => {
    const md = path.join(SITE, rel.replace(/\.html$/, '.md'));
    const d = fs.existsSync(md) ? (/^date:\s*["']?(\d{4}-\d{2}-\d{2})/m.exec(fs.readFileSync(md, 'utf8')) || [])[1] : '';
    return d ? `<lastmod>${d}</lastmod>` : '';
  };
  const urls = pages.map((p) => path.relative(DIST, p).replace(/\\/g, '/')).sort()
    .filter((rel) => !NOINDEX.has(rel))
    .map((rel) => `  <url><loc>${SITE_ORIGIN}/${rel === 'index.html' ? '' : rel}</loc>${lastmod(rel)}</url>`);
  fs.writeFileSync(path.join(DIST, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
  fs.writeFileSync(path.join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /mail/\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`);
  // メール配信用：最新の週のまとめから、配信するメールの中身を作る（worker が月曜 9:30 に読む）
  const mail = weeklyMail();
  if (mail) { fs.mkdirSync(path.join(DIST, 'mail'), { recursive: true }); fs.writeFileSync(path.join(DIST, 'mail', 'weekly-latest.json'), JSON.stringify(mail)); }
}

// 最新の週のまとめ（公開しているもの）から、メールの件名・本文を作る。特定電子メール法の表示を末尾に入れる
function weeklyMail() {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const plain = (s) => String(s).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
  const files = fs.readdirSync(path.join(DIST, 'articles')).filter((f) => /^weekly-\d{4}-W\d{2}\.html$/.test(f)).sort();
  if (!files.length) return null;
  const name = files[files.length - 1].replace(/\.html$/, '');
  const md = fs.readFileSync(path.join(SITE, 'articles', name + '.md'), 'utf8');
  const period = (/^period:\s*(.+)$/m.exec(md) || [])[1] || '';
  const pm = /(\d{4})-0?(\d+)-0?(\d+)\D+\d{4}-0?(\d+)-0?(\d+)/.exec(period);
  const range = pm ? `${pm[2]}/${pm[3]}〜${pm[4]}/${pm[5]}` : '';
  const lead = plain(((md.split(/^## 今週の総括\s*$/m)[1] || '').split(/^## /m)[0] || '').trim().split(/\n/)[0] || '');
  const items = [...md.matchAll(/^## (\d+)\.\s*(.+)\n+\*\*一言でいうと\*\*：(.+)$/gm)].map((m) => ({ title: plain(m[2]), one: plain(m[3]) }));
  if (!items.length) return null;
  const url = `${SITE_ORIGIN}/articles/${name}.html`;
  const subject = `KAIGO WEEKLY ${range}：${items[0].title}${items.length > 1 ? 'ほか' : ''}`.slice(0, 120);
  const html = `<!doctype html><html lang="ja"><body style="margin:0;padding:0;background:#f5f5f0;">
<div style="max-width:600px;margin:0 auto;padding:24px 20px;background:#ffffff;font-family:sans-serif;color:#222;line-height:1.8;font-size:15px;">
<p style="margin:0 0 4px;color:#2f7a4f;font-weight:bold;">KAIGO WEEKLY｜週刊・介護ニュースダイジェスト</p>
<p style="margin:0 0 16px;color:#666;font-size:13px;">${esc(range)} のニュース</p>
<p style="margin:0 0 20px;">${esc(lead)}</p>
${items.map((it, i) => `<h2 style="font-size:17px;margin:20px 0 6px;">${i + 1}. ${esc(it.title)}</h2>\n<p style="margin:0 0 6px;">${esc(it.one)}</p>`).join('\n')}
<p style="margin:24px 0;"><a href="${url}" style="display:inline-block;padding:12px 20px;background:#2f7a4f;color:#fff;text-decoration:none;border-radius:6px;">要点・影響・注意点をまとめて読む</a></p>
<hr style="border:0;border-top:1px solid #ddd;margin:24px 0;">
<p style="margin:0;font-size:12px;color:#666;line-height:1.7;">
このメールは、KAIGO WEEKLY のメール配信に登録された方にお送りしています。<br>
配信の停止：<a href="{{ unsubscribe }}">こちらから配信を停止する</a>（またはこのメールに「停止」と返信してください）<br>
送信者：KAIGO WEEKLY（運営：${esc(OPERATOR.name)}）<br>
住所：${esc(OPERATOR.address)}<br>
お問い合わせ：info@kaigoweekly.jp<br>
<a href="${SITE_ORIGIN}/articles/privacy.html">プライバシーポリシー</a>
</p>
</div></body></html>`;
  return { week: name.replace(/^weekly-/, ''), generatedAt: new Date().toISOString(), subject, html };
}

// GA4 のタグと、主な行動のイベント（相談・ご要望の送信、メール登録欄へのクリック、記事へのクリック）
function gaSnippet(id) {
  return `<script>
// 運営者の閲覧を数えない：?ga=off（または ?notrack=1）で開くと、そのブラウザでは以後計測しない（?ga=on／?notrack=0 で元に戻す）。
// 印を保存できないブラウザでは、ふつうに計測する
try {
  var sp = new URLSearchParams(location.search), q = sp.get('ga') || sp.get('notrack');
  if (q === 'off' || q === '1') localStorage.setItem('kw-notrack', '1');
  if (q === 'on' || q === '0') localStorage.removeItem('kw-notrack');
  if (localStorage.getItem('kw-notrack') === '1') window['ga-disable-${id}'] = true;
} catch (e) {}
</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${id}');
// 送信の成功（index.html のフォームが kw:submitted を出す）
document.addEventListener('kw:submitted', function (e) { var f = e.detail && e.detail.form; gtag('event', f === 'contact-form' ? 'generate_lead' : f === 'subscribe-form' ? 'sign_up' : 'voice_submit', { form_id: f }); });
// メールで受け取る・記事へのクリック
document.addEventListener('click', function (e) {
  var a = e.target.closest && e.target.closest('a'); if (!a) return;
  var h = a.getAttribute('href') || '';
  if (/^((\\.\\.\\/)?index\\.html)?#mail$/.test(h)) gtag('event', 'mail_signup_click', { link_text: (a.textContent || '').trim().slice(0, 40) });
  else if (/(^|\\/)articles\\/[^/]+\\.html/.test(h)) gtag('event', 'select_content', { content_type: 'article', item_id: h.replace(/^.*articles\\//, '').replace(/\\.html.*$/, '') });
});
</script>`;
}

// 点検
const problems = [];
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : files.push(p); } };
walk(DIST);
if (files.length >= MAX_FILES) problems.push(`ファイルが多すぎる：${files.length}`);
for (const p of files) {
  const rel = path.relative(DIST, p).replace(/\\/g, '/');
  const size = fs.statSync(p).size;
  if (size >= MAX_BYTES) problems.push(`25MBを超えるファイル：${rel}（${size}バイト）`);
  if (!/\.(html|css|js|png|jpe?g|webp|svg|mp4|ico|txt|xml|json|woff2?)$/i.test(rel)) problems.push(`入れてはいけない種類のファイル：${rel}`);
  if (/(^|\/)(営業|_design|_preview|tools|動画|node_modules)\//.test(rel) || /\.md$/i.test(rel)) problems.push(`作業用のファイルが混ざっている：${rel}`);
  if (/\.html$/i.test(rel)) {
    const t = fs.readFileSync(p, 'utf8');
    if (!NOINDEX.has(rel) && /name="robots"[^>]*noindex/i.test(t)) problems.push(`検索に載せない設定（noindex）が残っている：${rel}`);
    if (/class="sample-bar"/.test(t)) problems.push(`試作の帯が残っている：${rel}`);
    if (/試作のため/.test(t)) problems.push(`「試作のため」の文言が残っている：${rel}`);
    if (t.includes('__TURNSTILE_SITEKEY__')) problems.push(`いたずら防止のサイトキーが入っていない：${rel}（環境変数 TURNSTILE_SITEKEY）`);
    const canon = [...t.matchAll(/<link rel="canonical" href="([^"]*)">/g)].map((m) => m[1]);
    const expect = SITE_ORIGIN + '/' + (rel === 'index.html' ? '' : rel);
    if (canon.length !== 1 || canon[0] !== expect) problems.push(`正規のURL（canonical）が正しくない：${rel}（${canon.join(', ') || 'なし'}）`);
    if (!GA4 && /Google アナリティクス/.test(t)) problems.push(`GA4 を入れていないのに、Google アナリティクスの説明がある：${rel}`);
    if (GA4 && !t.includes(`gtag/js?id=${GA4}`)) problems.push(`アクセス解析（GA4）のタグがない：${rel}`);
    if (GA4 && rel === 'articles/privacy.html' && !/Google アナリティクス/.test(t)) problems.push('GA4 を入れるのに、プライバシーポリシーに Google アナリティクスの説明がない');
    const mails = (t.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).filter((m) => !/@kaigoweekly\.jp$/i.test(m));
    if (mails.length) problems.push(`kaigoweekly.jp 以外のメールアドレスがある：${rel}（${[...new Set(mails)].join(', ')}）`);
  }
}

if (skipped.length) console.log(`入れなかった html：${skipped.join(', ')}`);
// サイト内リンク切れの点検（html の href/src が dist の中にあるか）
for (const p of files.filter((x) => x.endsWith('.html'))) {
  const t = fs.readFileSync(p, 'utf8'), base = path.dirname(p);
  for (const m of t.matchAll(/(?:href|src)="([^"#?]+)(?:[#?][^"]*)?"/g)) {
    const u = m[1];
    if (/^(https?:|mailto:|tel:|data:|javascript:|\/\/|\/api\/)/i.test(u) || u.startsWith('#')) continue;
    const target = u.startsWith('/') ? path.join(DIST, u) : path.join(base, u);
    if (!fs.existsSync(target)) problems.push(`リンク先がない：${path.relative(DIST, p).replace(/\\/g, '/')} → ${u}`);
  }
}
console.log(`dist：${files.length}ファイル、${(files.reduce((s, p) => s + fs.statSync(p).size, 0) / 1024 / 1024).toFixed(1)}MB`);
if (problems.length) {
  const shown = problems.slice(0, 30);
  console.log(`点検：不合格 ${problems.length}件`);
  for (const m of shown) console.log(' - ' + m);
  if (problems.length > shown.length) console.log(` …ほか${problems.length - shown.length}件`);
  process.exit(1);
}
console.log('点検：合格');
