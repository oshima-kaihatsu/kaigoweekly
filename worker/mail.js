// KAIGO WEEKLY のメール登録（Brevo のダブルオプトイン）と、週のまとめの配信（2026-11-13、Codex 指摘の反映版）
//
// 受付の可否：wrangler.toml の MAIL_SIGNUP が "1" で、Brevo の名簿・ひな形の番号と鍵がそろっているときだけ（mailReady）。
//   公開用フォルダの登録欄の表示も、同じ MAIL_SIGNUP を make-dist.mjs が読んで決める（1か所で管理）。
// 登録：/api/subscribe → Brevo が確認メールを送る。本人が確認のボタンを押すと、Brevo が
//   /api/confirmed?c=<記録の番号>&s=<署名> へ移すので、そこで「確認した日時」を記録してから完了ページへ移す。
// いたずら対策：Turnstile、IPごとの回数制限（index.js）、同じアドレスへの確認メールは24時間に1回、全体で1日100件まで。
// 同意の記録（consents）：申込の日時・文言の版、確認の日時。
//   ・確認されなかった申込は30日で消す。
//   ・確認済みの記録は、配信を続けている間は残し、配信が止まった（Brevo で配信停止・名簿から外れた）と分かった日から1年で消す。
//     配信の状況は毎日少しずつ Brevo に問い合わせて調べる。
// 週のまとめの配信（campaigns）：週ごとに1行。先に行を確保してから Brevo を呼ぶ（二重に作らない・送らない）。
//   status：claimed（確保）→ created（下書き作成）→ sent（送信済み）／failed（失敗）。notified：運営者に知らせたか。

const DAY = 86400000;
export const CONSENT_TEXT_VERSION = 'v2-2026-11-14'; // v2：案内の文言から「無料点検」を外した // index.html の同意の文言を変えたら上げる
const KEEP_UNCONFIRMED_DAYS = 30;
const KEEP_AFTER_STOP_DAYS = 365;
const PER_ADDRESS_COOLDOWN = DAY;
const DAILY_CAP = 100;
const FREE_DAILY_LIMIT = 300;

export async function brevo(env, method, pathname, body) {
  try {
    const r = await fetch('https://api.brevo.com/v3' + pathname, {
      method, headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const t = await r.text();
    let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
    return { ok: r.ok, status: r.status, body: j, text: t.slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, body: null, text: String(e).slice(0, 300), unknown: true }; // 届いたか分からない
  }
}

export function mailReady(env) {
  return !!((env.MAIL_SIGNUP === '1' || env.MAIL_SIGNUP === 'test') && env.DB && env.BREVO_API_KEY && env.CONSENT_SIGNING_KEY
    && /^\d+$/.test(env.BREVO_LIST_ID || '') && /^\d+$/.test(env.BREVO_DOI_TEMPLATE_ID || '') && env.TURNSTILE_SECRET);
}

async function sign(env, s) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.CONSENT_SIGNING_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(s)));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export async function handleSubscribe(request, env, h) {
  const d = await h.readBody(request);
  if (!d) return h.json(400, { error: '送信の形が正しくありません。' });
  const ok = h.json(200, { message: '確認のメールをお送りしました。メールの中のボタンを押すと、登録が終わります。' });
  if (d.website) return ok;
  if (d.agree !== '1') return h.json(400, { error: '配信の内容への同意が必要です。' });
  const raw = h.text(d.email, 200, true);
  if (!raw || !h.EMAIL_RE.test(raw)) return h.json(400, { error: 'メールアドレスの形を確かめてください。' });
  const email = raw.toLowerCase();
  if (!(await h.verifyTurnstile(env, d.turnstile, request.headers.get('cf-connecting-ip')))) return h.json(403, { error: 'いたずら防止の確認ができませんでした。ページを読み込み直して、もう一度お試しください。' });
  const now = Date.now();
  // 同じアドレスへの確認メールは24時間に1回、全体で1日100件まで（他人のアドレスで何度も送らせないため）。
  // 確認と記録を1つの文で行うので、同時に来ても枠を超えない。結果は同じ返事にして、登録の有無を明かさない
  const id = crypto.randomUUID();
  const ins = await env.DB.prepare(`INSERT INTO consents (id, created_at, email, text_version, source)
    SELECT ?, ?, ?, ?, 'top-mail-card'
    WHERE NOT EXISTS (SELECT 1 FROM consents WHERE email = ? AND created_at > ?)
      AND (SELECT count(*) FROM consents WHERE created_at > ?) < ?`)
    .bind(id, now, email, CONSENT_TEXT_VERSION, email, now - PER_ADDRESS_COOLDOWN, now - DAY, DAILY_CAP).run();
  if (!ins.meta || ins.meta.changes !== 1) return ok;
  const s = await sign(env, id);
  const r = await brevo(env, 'POST', '/contacts/doubleOptinConfirmation', {
    email: raw, includeListIds: [Number(env.BREVO_LIST_ID)], templateId: Number(env.BREVO_DOI_TEMPLATE_ID),
    redirectionUrl: `https://kaigoweekly.jp/api/confirmed?c=${id}&s=${s}`,
  });
  if (!r.ok) {
    console.log('brevo doi failed', r.status, r.text);
    // 返事が途中で切れたとき（送れたかどうか分からない）は、記録を残す（確認のボタンが押されたら記録できるように）。
    // はっきり断られたときだけ消す。確認されない記録は30日で消える
    if (!r.unknown && r.status >= 400 && r.status < 500) await env.DB.prepare('DELETE FROM consents WHERE id = ?').bind(id).run(); // 4xx＝はっきり断られた。5xx は処理済みかもしれないので残す
    return h.json(502, { error: '確認のメールを送れなかった可能性があります。数分たっても届かない場合は、明日あらためてお試しください。' });
  }
  return ok;
}

// 確認のボタンを押した後、Brevo から移ってくる先。確認の日時を記録して、完了のページへ移す
export async function handleConfirmed(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get('c') || '', s = url.searchParams.get('s') || '';
  const done = Response.redirect('https://kaigoweekly.jp/articles/subscribed.html', 302);
  if (!/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f]{32}$/.test(s) || !env.CONSENT_SIGNING_KEY) return done;
  if ((await sign(env, id)) !== s) return done;
  await env.DB.prepare('UPDATE consents SET confirmed_at = COALESCE(confirmed_at, ?) WHERE id = ?').bind(Date.now(), id).run();
  return done;
}

// 前の週（月〜日）の ISO 週番号。月曜の朝に公開されたはずの週
function expectedWeek(now) {
  const d = new Date(now + 9 * 3600e3);
  d.setUTCDate(d.getUTCDate() - 7);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7));
  const y = t.getUTCFullYear(), jan4 = new Date(Date.UTC(y, 0, 4));
  const wk = 1 + Math.round(((t - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${y}-W${String(wk).padStart(2, '0')}`;
}

async function tell(env, h, week, subject, body) {
  try { await h.notify(env, subject, body); if (week) await env.DB.prepare('UPDATE campaigns SET notified = 1 WHERE week = ?').bind(week).run(); }
  catch (e) { console.log('notify failed', String(e)); }
}

// 毎週月曜 8:30（日本時間）。2026-11-16 から確認なしで自動送信（WEEKLY_AUTO_SEND="1"）。
// 記事が0本の週は、make-dist.mjs が「審議中の案件リスト」を同じ週の番号で用意するので、そのまま送る
export async function weeklyCampaign(env, h) {
  if (!mailReady(env)) { console.log('weekly: mail not ready'); return; }
  const want = expectedWeek(Date.now());
  const res = await env.ASSETS.fetch(new Request('https://kaigoweekly.jp/mail/weekly-latest.json'));
  const m = res.ok ? await res.json().catch(() => null) : null;
  if (!m || m.week !== want || !m.subject || !m.html) {
    await tell(env, h, null, `【要確認】週のまとめ（${want}）の配信の準備ができませんでした`,
      `公開されている最新の週のまとめが ${m && m.week ? m.week : '（なし）'} で、${want} ではありません。月曜朝の自動更新（GitHub Actions の「毎週のニュース更新」）が失敗したか、まだ終わっていない可能性があります。今週の配信は送りません。GitHub の Actions の画面で失敗していないか確かめ、Claude に「週のまとめの配信が届かなかった」と伝えてください。`);
    return;
  }
  // 先に週の行を確保する（同時に動いても、2つ目はここで止まる）
  const claim = await env.DB.prepare("INSERT INTO campaigns (week, created_at, status, sent, notified) VALUES (?, ?, 'claimed', 0, 0) ON CONFLICT(week) DO NOTHING").bind(m.week, Date.now()).run();
  if (!claim.meta || claim.meta.changes !== 1) return;
  // 読者の数（無料プランは1日300通まで）
  const list = await brevo(env, 'GET', `/contacts/lists/${env.BREVO_LIST_ID}`);
  const n = list.ok && list.body ? (list.body.uniqueSubscribers ?? list.body.totalSubscribers ?? null) : null;
  const name = `KAIGO WEEKLY ${m.week}`;
  const c = await brevo(env, 'POST', '/emailCampaigns', {
    name, subject: m.subject, sender: { name: 'KAIGO WEEKLY', email: env.NEWS_FROM || 'news@kaigoweekly.jp' }, replyTo: 'info@kaigoweekly.jp',
    htmlContent: m.html, recipients: { listIds: [Number(env.BREVO_LIST_ID)] },
  });
  if (!c.ok || !c.body || !c.body.id) {
    await env.DB.prepare("UPDATE campaigns SET status = 'failed', error = ? WHERE week = ?").bind(`create ${c.status} ${c.text}`, m.week).run();
    await tell(env, h, m.week, `【要確認】週のまとめ（${m.week}）の配信の下書きを作れませんでした`,
      `${c.unknown ? 'Brevo からの返事が途中で切れました。Brevo の Campaigns に「' + name + '」ができていないか確かめてください（あれば、それを使ってください）。' : 'Brevo の応答：' + c.status + ' ' + c.text}\n\nClaude に「週のまとめの配信が失敗した」と伝えてください。自動ではやり直しません（二重に送らないため）。`);
    return;
  }
  await env.DB.prepare("UPDATE campaigns SET status = 'created', campaign_id = ? WHERE week = ?").bind(String(c.body.id), m.week).run();
  const over = n !== null && n > FREE_DAILY_LIMIT;
  const near = n !== null && n > FREE_DAILY_LIMIT * 0.9;
  const capNote = n === null
    ? '\n読者の数を Brevo から取れませんでした。送る前に、Brevo の名簿の人数が300人以下か確かめてください（自動では送りません）。'
    : `\n読者の数：${n}人。${over ? '無料プランの1日300通を超えています。300通を送った後は止まるので、翌日に Brevo の画面で残りを再開してください（有料プランへの変更も検討してください）。' : near ? '無料プランの1日300通に近づいています。有料プランへの変更を検討してください。' : ''}`;
  if (env.WEEKLY_AUTO_SEND === '1' && n !== null && !over) {
    const s = await brevo(env, 'POST', `/emailCampaigns/${c.body.id}/sendNow`);
    if (s.ok) {
      await env.DB.prepare("UPDATE campaigns SET status = 'sent', sent = 1 WHERE week = ?").bind(m.week).run();
      await tell(env, h, m.week, `【配信】週のまとめ（${m.week}）を配信しました`, `Brevo のキャンペーン「${name}」を送りました。${capNote}`);
    } else {
      await env.DB.prepare("UPDATE campaigns SET status = 'failed', error = ? WHERE week = ?").bind(`send ${s.status} ${s.text}`, m.week).run();
      await tell(env, h, m.week, `【要確認】週のまとめ（${m.week}）を送れませんでした`,
        `下書き「${name}」はできています。Brevo の画面で送信済みになっていないか確かめ、なっていなければ「Send now」を押してください。\nBrevo の応答：${s.status} ${s.text}${capNote}`);
    }
    return;
  }
  await tell(env, h, m.week, `【確認】週のまとめ（${m.week}）の配信の下書きを作りました`,
    `Brevo の画面 → Campaigns →「${name}」を開き、中身を確かめて「Send now」（今すぐ送信）を押してください。\n件名：${m.subject}${capNote}`);
}

// 毎日：知らせられなかった配信の知らせ直し、同意の記録の整理
export async function mailDaily(env, h) {
  if (!env.DB) return;
  const now = Date.now();
  try {
    const { results } = await env.DB.prepare('SELECT week, status, error FROM campaigns WHERE notified = 0 LIMIT 5').all();
    for (const r of results || []) await tell(env, h, r.week, `【要確認】週のまとめ（${r.week}）の配信の状態：${r.status}`, `お知らせを送れていなかったため、知らせ直します。${r.error ? '\n記録：' + r.error : ''}\nBrevo の Campaigns で状態を確かめてください。`);
  } catch (e) { console.log('campaign renotify failed', String(e)); }
  try {
    await env.DB.prepare('DELETE FROM consents WHERE confirmed_at IS NULL AND created_at < ?').bind(now - KEEP_UNCONFIRMED_DAYS * DAY).run();
    await env.DB.prepare('DELETE FROM consents WHERE stopped_at IS NOT NULL AND stopped_at < ?').bind(now - KEEP_AFTER_STOP_DAYS * DAY).run();
  } catch (e) { console.log('consents cleanup failed', String(e)); }
  // 配信が止まった人を調べる（毎日50件ずつ＝30日で1,500人まで。無料プランの上限300人に十分）
  if (!env.BREVO_API_KEY || !/^\d+$/.test(env.BREVO_LIST_ID || '')) return;
  try {
    const { results } = await env.DB.prepare('SELECT id, email FROM consents WHERE confirmed_at IS NOT NULL AND stopped_at IS NULL AND (checked_at IS NULL OR checked_at < ?) ORDER BY checked_at LIMIT 50').bind(now - 30 * DAY).all();
    for (const r of results || []) {
      const c = await brevo(env, 'GET', `/contacts/${encodeURIComponent(r.email)}`);
      if (c.status === 404 || (c.ok && c.body && (c.body.emailBlacklisted || !(c.body.listIds || []).includes(Number(env.BREVO_LIST_ID))))) {
        await env.DB.prepare('UPDATE consents SET stopped_at = ?, checked_at = ? WHERE id = ?').bind(now, now, r.id).run();
      } else {
        // 確かめられたときも、失敗したときも、問い合わせた時刻を付けて順番を回す（失敗した行が毎日先頭を占めないように）
        await env.DB.prepare('UPDATE consents SET checked_at = ? WHERE id = ?').bind(now, r.id).run();
      }
    }
  } catch (e) { console.log('consents check failed', String(e)); }
}
