// KAIGO WEEKLY のサーバー側（Cloudflare Workers）。
// - /api/contact：相談フォーム。/api/voice：ご要望。それ以外は dist/ の静的ファイルをそのまま返す。
// - 受け取った内容は D1（DB）に保存し、運営者のGmailへお知らせを送る（NOTIFY。送り先はEmail Routingで確認済みのアドレスだけ）。
// - 毎日1回、保存期間を過ぎた行を消す（プライバシーポリシーの保存期間）。
import { EmailMessage } from 'cloudflare:email';
import { mailReady, handleSubscribe, handleConfirmed, weeklyCampaign, mailDaily } from './mail.js';

const DAY = 86400000;
const KEEP_AFTER_REPLY_DAYS = 365;   // 相談：返答が終わってから1年
const KEEP_VOICE_DAYS = 365;         // ご要望：受け取ってから1年
const KEEP_UNREPLIED_DAYS = 730;     // 返答の記録が付かないままの相談も、受け取ってから2年で消す（消し忘れの防止）

const CONTACT_INTERESTS = new Set(['monthly', 'ai-okuri', 'ai-sougei', 'ai-kaigi', 'ai-kyuka', 'ai-car', 'ai-zaiko', 'ai-setsubi', 'ai',
  'set', 'tenken', 'kyujin', 'site', 'corpmovie', 'staffmovie', 'snsrec', 'photo', 'tools',
  'manualmovie', 'ai-manual', 'mendan', 'ai-board', 'hp', 'movie', 'print', 'sns', 'ai-draft', 'other', 'demo']);
const INTEREST_NAMES = {"monthly": "パートナー契約（月額）", "ai-okuri": "申し送りのAI化", "ai-sougei": "送迎表づくりの効率化", "ai-kaigi": "会議・日報のAI整理", "ai-kyuka": "有給・休暇管理", "ai-car": "送迎車の点検・期限管理", "ai-zaiko": "介護用品の在庫管理", "ai-setsubi": "設備・防災の点検表", "ai": "そのほかの事務へのAI導入（書類の下書きなど）", "set": "求人ツール一式（キャンペーン）", "demo": "業務効率化アプリのデモ作成（無料）", "tenken": "無料点検", "kyujin": "求人原稿作成", "site": "採用サイト・ページ制作", "corpmovie": "企業動画制作", "staffmovie": "スタッフ紹介動画", "snsrec": "SNS運用代行（採用向け）", "photo": "写真撮影", "tools": "各種採用ツール（段取り表・文例など）", "manualmovie": "マニュアル・研修動画（介助手順・新人研修・感染対策など）", "ai-manual": "AIマニュアル・研修", "mendan": "入職後の面談シート", "ai-board": "職員の掲示板・目安箱", "hp": "コーポレートサイト・更新サポート", "movie": "施設紹介・ご家族向けの動画", "print": "パンフレット・チラシ・広報誌", "sns": "SNSの立ち上げ・運用代行・LINE配信", "ai-draft": "SNS投稿・施設だよりの作成効率化（AI下書き）", "other": "その他・まだ決めていない"};
const KINDS = new Set(['', '訪問介護', '通所介護（デイサービス）', '認知症グループホーム', '特別養護老人ホーム', '介護老人保健施設', '有料老人ホーム・サ高住', '居宅介護支援', 'その他']);
const VOICE_WANTS = new Set(['制度の期限の一覧', '補助金のまとめ', 'template', 'region', '試算をもっと']);
const VOICE_NAMES = { template: '求人票のテンプレ・事例集', region: '自分の地域の求人の数字' };
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{4,190}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

function text(v, max, required) {
  if (v == null) v = '';
  if (typeof v !== 'string') return null;
  v = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (v.length > max) return null;
  if (required && !v) return null;
  return v;
}

async function verifyTurnstile(env, token, ip) {
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  const fd = new FormData();
  fd.append('secret', env.TURNSTILE_SECRET);
  fd.append('response', token);
  if (ip) fd.append('remoteip', ip);
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: fd });
    const j = await r.json();
    const hosts = (env.TURNSTILE_HOSTNAME || '').split(',').map((s) => s.trim()).filter(Boolean);
    return j.success === true && (!hosts.length || hosts.includes(j.hostname));
  } catch { return false; }
}

// UTF-8 の本文を base64 で包んだ、最小限のメール
function b64(s) { const b = new TextEncoder().encode(s); let bin = ''; for (const c of b) bin += String.fromCharCode(c); return btoa(bin); }
async function notify(env, subject, body) {
  if (!env.NOTIFY || !env.NOTIFY_FROM || !env.NOTIFY_TO) return;
  const raw = [
    `From: KAIGO WEEKLY <${env.NOTIFY_FROM}>`,
    `To: ${env.NOTIFY_TO}`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Message-ID: <${crypto.randomUUID()}@${env.NOTIFY_FROM.split('@')[1]}>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(body).replace(/.{76}/g, '$&\r\n'),
  ].join('\r\n');
  await env.NOTIFY.send(new EmailMessage(env.NOTIFY_FROM, env.NOTIFY_TO, raw));
}

// お知らせを送り、送れたら notified_at を付ける。送れなければ毎日の処理で知らせ直す
async function sendAndMark(env, table, id, subject, body) {
  try {
    await notify(env, subject, body);
    await env.DB.prepare(`UPDATE ${table} SET notified_at = ? WHERE id = ?`).bind(Date.now(), id).run();
  } catch (e) { console.log('notify failed', table, id, String(e)); }
}

// 本文は上限（20,000バイト）まで読み、超えたらそこで止める
async function readBody(request) {
  if (!(request.headers.get('content-type') || '').startsWith('application/json')) return null;
  const MAX = 20000;
  if (Number(request.headers.get('content-length') || 0) > MAX) return null;
  if (!request.body) return null;
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX) { try { await reader.cancel(); } catch {} return null; }
    chunks.push(value);
  }
  const buf = new Uint8Array(size); let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  try { const j = JSON.parse(new TextDecoder().decode(buf)); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; }
}

// 送信回数の制限（IPアドレスごと。IPアドレスは保存しない）
async function tooMany(env, request) {
  if (!env.LIMIT) return false;
  try { const { success } = await env.LIMIT.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' }); return !success; } catch { return false; }
}

// 受付に必要な設定がそろっているか（そろっていなければ受け付けない）
function ready(env) {
  return !!(env.DB && env.NOTIFY && env.NOTIFY_FROM && env.NOTIFY_TO && env.TURNSTILE_SECRET);
}

function sameOrigin(request, env) {
  const o = request.headers.get('origin');
  if (!o) return false;
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return allowed.includes(o);
}

async function handleContact(request, env, ctx) {
  const d = await readBody(request);
  if (!d) return json(400, { error: '送信の形が正しくありません。' });
  if (d.website) return json(200, { message: '送信しました。ありがとうございました。' }); // いたずら：保存せずに終える
  if (d.agree !== '1') return json(400, { error: 'プライバシーポリシーへの同意が必要です。' });
  const org = text(d.org, 100, true), name = text(d.name, 60, true), email = text(d.email, 200, true);
  const tel = text(d.tel, 30), office = text(d.office, 100), kind = text(d.kind, 40), message = text(d.message, 2000);
  if ([org, name, email, tel, office, kind, message].some((v) => v === null)) return json(400, { error: '入力の長さや形を確かめてください。' });
  if (!EMAIL_RE.test(email)) return json(400, { error: 'メールアドレスの形を確かめてください。' });
  if (tel && !/^[0-9+\-() ０-９－（）]{0,30}$/.test(tel)) return json(400, { error: '電話番号は数字とハイフンで入れてください。' });
  if (!KINDS.has(kind)) return json(400, { error: 'サービスの種類を選び直してください。' });
  const interests = Array.isArray(d.interest) ? d.interest : [];
  if (interests.length > 40 || interests.some((k) => !CONTACT_INTERESTS.has(k))) return json(400, { error: '興味のあるものを選び直してください。' });
  if (!(await verifyTurnstile(env, d.turnstile, request.headers.get('cf-connecting-ip')))) return json(403, { error: 'いたずら防止の確認ができませんでした。ページを読み込み直して、もう一度お試しください。' });

  const id = crypto.randomUUID(), now = Date.now();
  await env.DB.prepare('INSERT INTO contacts (id, created_at, org, name, email, tel, office, kind, interests, message) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(id, now, org, name, email, tel, office, kind, [...new Set(interests)].join(','), message).run();
  ctx.waitUntil(sendAndMark(env, 'contacts', id, `【相談】${org} ${name}様`, [
    '相談フォームに送信がありました。3営業日以内に返信してください。',
    '', `法人名：${org}`, `お名前：${name}`, `メール：${email}`, `電話：${tel || '（なし）'}`, `事業所名：${office || '（なし）'}`,
    `サービスの種類：${kind || '（なし）'}`, `興味のあるもの：${[...new Set(interests)].map((k) => INTEREST_NAMES[k] || k).join('、') || '（なし）'}`, '', 'ご相談内容：', message || '（なし）',
    '', `受付番号：${id}`, `受付日時：${new Date(now).toISOString()}`,
  ].join('\n')));
  return json(200, { message: '送信しました。3営業日以内に、メールでご連絡します。' });
}

async function handleVoice(request, env, ctx) {
  const d = await readBody(request);
  if (!d) return json(400, { error: '送信の形が正しくありません。' });
  if (d.website) return json(200, { message: '送信しました。ありがとうございました。' });
  if (d.agree !== '1') return json(400, { error: 'プライバシーポリシーへの同意が必要です。' });
  const message = text(d.message, 1000), email = text(d.email, 200);
  if (message === null || email === null) return json(400, { error: '入力の長さを確かめてください。' });
  if (email && !EMAIL_RE.test(email)) return json(400, { error: 'メールアドレスの形を確かめてください。' });
  const wants = Array.isArray(d.want) ? d.want : [];
  if (wants.length > 10 || wants.some((k) => !VOICE_WANTS.has(k))) return json(400, { error: '選択肢を選び直してください。' });
  if (!message && !wants.length) return json(400, { error: 'ほしいものを選ぶか、ひとことを書いてください。' });
  if (!(await verifyTurnstile(env, d.turnstile, request.headers.get('cf-connecting-ip')))) return json(403, { error: 'いたずら防止の確認ができませんでした。ページを読み込み直して、もう一度お試しください。' });

  const id = crypto.randomUUID(), now = Date.now(), quoteOk = d.quote_ok === '1' ? 1 : 0;
  await env.DB.prepare('INSERT INTO voices (id, created_at, wants, message, email, quote_ok) VALUES (?,?,?,?,?,?)')
    .bind(id, now, [...new Set(wants)].join(','), message, email, quoteOk).run();
  ctx.waitUntil(sendAndMark(env, 'voices', id, '【ご要望】KAIGO WEEKLY', [
    'ご要望が届きました。', '', `ほしいもの：${[...new Set(wants)].map((k) => VOICE_NAMES[k] || k).join('、') || '（なし）'}`, `ひとこと：${message || '（なし）'}`,
    `返信先：${email || '（なし）'}`, `記事での紹介：${quoteOk ? 'してよい' : 'しない'}`, '', `受付番号：${id}`,
  ].join('\n')));
  return json(200, { message: '送信しました。ありがとうございました。' });
}

// mail.js に渡す共通の道具
const H = { json, text, readBody, verifyTurnstile, notify, EMAIL_RE };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/subscribe') {
      if (request.method !== 'POST') return json(405, { error: '送信の方法が正しくありません。' });
      if (!sameOrigin(request, env)) return json(403, { error: 'このページからは送信できません。' });
      if (!mailReady(env)) return json(503, { error: 'メールの登録は準備中です。' });
      if (await tooMany(env, request)) return json(429, { error: '短い時間に何度も送信されました。少し時間をおいてお試しください。' });
      try { return await handleSubscribe(request, env, H); }
      catch (e) { console.log('subscribe error', String(e)); return json(500, { error: '登録できませんでした。時間をおいて、もう一度お試しください。' }); }
    }
    if (url.pathname === '/api/confirmed') {
      if (request.method !== 'GET') return json(405, { error: '送信の方法が正しくありません。' });
      try { return await handleConfirmed(request, env); }
      catch (e) { console.log('confirmed error', String(e)); return Response.redirect('https://kaigoweekly.jp/articles/subscribed.html', 302); }
    }
    if (url.pathname === '/api/contact' || url.pathname === '/api/voice') {
      if (request.method !== 'POST') return json(405, { error: '送信の方法が正しくありません。' });
      if (!sameOrigin(request, env)) return json(403, { error: 'このページからは送信できません。' });
      if (!ready(env)) return json(503, { error: 'ただいま受付を止めています。info@kaigoweekly.jp へメールでお送りください。' });
      if (await tooMany(env, request)) return json(429, { error: '短い時間に何度も送信されました。少し時間をおいてお試しください。' });
      try {
        return url.pathname === '/api/contact' ? await handleContact(request, env, ctx) : await handleVoice(request, env, ctx);
      } catch (e) {
        console.log('api error', String(e));
        return json(500, { error: '送信できませんでした。時間をおいて、もう一度お試しください。' });
      }
    }
    if (url.pathname.startsWith('/api/')) return json(404, { error: '見つかりません。' });
    // ここに来るのは、静的ファイルが見つからなかったときだけ（wrangler.toml の html_handling = "none"）
    // www は https://kaigoweekly.jp へまとめる
    if (url.hostname === 'www.kaigoweekly.jp') { url.hostname = 'kaigoweekly.jp'; return Response.redirect(url.toString(), 301); }
    if (request.method === 'GET' || request.method === 'HEAD') {
      // トップ：/ は index.html を返す
      if (url.pathname === '/') return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
      // 拡張子のないURL（以前の /articles/about など）は .html へ
      if (/^\/[A-Za-z0-9/_-]+$/.test(url.pathname)) {
        const p = url.pathname.replace(/\/$/, '') + '.html';
        const r = await env.ASSETS.fetch(new Request(new URL(p, url), { method: 'HEAD' }));
        if (r.ok) { url.pathname = p; return Response.redirect(url.toString(), 301); }
      }
    }
    return env.ASSETS.fetch(request);
  },
  // 毎日1回：保存期間を過ぎた行を消す
  async scheduled(event, env) {
    if (event.cron === '30 23 * * 0') { await weeklyCampaign(env, H); await mailDaily(env, H); return; } // 月曜 8:30（日本時間）。毎日の確認も行う
    const now = Date.now();
    await mailDaily(env, H); // 配信の知らせ直し、同意の記録の整理
    // お知らせを送れなかった受付があれば、件数と受付番号だけを知らせ直す（中身はデータベースにある）
    for (const table of ['contacts', 'voices']) {
      const { results } = await env.DB.prepare(`SELECT id FROM ${table} WHERE notified_at IS NULL ORDER BY created_at LIMIT 50`).all();
      if (!results || !results.length) continue;
      try {
        await notify(env, `【要確認】お知らせを送れなかった受付が${results.length}件あります`,
          `受付番号：\n${results.map((r) => r.id).join('\n')}\n\nClaudeに「KAIGO WEEKLYの未通知の受付を見せて」と頼んでください。`);
        await env.DB.prepare(`UPDATE ${table} SET notified_at = ? WHERE id IN (${results.map(() => '?').join(',')})`).bind(now, ...results.map((r) => r.id)).run();
      } catch (e) { console.log('renotify failed', table, String(e)); }
    }
    const cond = {
      contacts: ['(replied_at IS NOT NULL AND replied_at < ?) OR (replied_at IS NULL AND created_at < ?)', [now - KEEP_AFTER_REPLY_DAYS * DAY, now - KEEP_UNREPLIED_DAYS * DAY]],
      voices: ['created_at < ?', [now - KEEP_VOICE_DAYS * DAY]],
    };
    // 消す前に、Gmailの方でも消すお知らせの受付番号を運営者に知らせる（知らせられたときだけ消す）
    for (const [table, [where, args]] of Object.entries(cond)) {
      const { results } = await env.DB.prepare(`SELECT id FROM ${table} WHERE ${where} LIMIT 200`).bind(...args).all();
      if (!results || !results.length) continue;
      try {
        await notify(env, `【整理】保存期間を過ぎた受付${results.length}件を消しました`,
          `Gmailで次の受付番号を検索し、出てきたお知らせのメールも消してください。\n\n${results.map((r) => r.id).join('\n')}`);
        await env.DB.prepare(`DELETE FROM ${table} WHERE id IN (${results.map(() => '?').join(',')})`).bind(...results.map((r) => r.id)).run();
      } catch (e) { console.log('cleanup failed', table, String(e)); }
    }
  },
};
