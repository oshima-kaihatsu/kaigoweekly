-- KAIGO WEEKLY の受付の記録（D1）。保存期間は worker/index.js の scheduled で消す。
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,   -- 受け取った日時（ミリ秒）
  org TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  tel TEXT,
  office TEXT,
  kind TEXT,
  interests TEXT,
  message TEXT,
  replied_at INTEGER,            -- 返答が終わった日時。ここから1年で消す（記録は worker/README.md の手順で付ける）
  notified_at INTEGER            -- 運営者へのお知らせを送った日時（送れなければ毎日の処理で知らせ直す）
);
CREATE INDEX IF NOT EXISTS contacts_created ON contacts (created_at);

CREATE TABLE IF NOT EXISTS voices (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  wants TEXT,
  message TEXT,
  email TEXT,
  quote_ok INTEGER NOT NULL DEFAULT 0,
  notified_at INTEGER
);
CREATE INDEX IF NOT EXISTS voices_created ON voices (created_at);

-- メール登録の同意の記録（2026-11-13）。確認されなかった申込は30日、配信が止まった人は1年で消す
CREATE TABLE IF NOT EXISTS consents (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  email TEXT NOT NULL,
  text_version TEXT NOT NULL,   -- 同意した文言の版（worker/index.js の CONSENT_TEXT_VERSION）
  source TEXT,
  confirmed_at INTEGER,          -- 確認のボタンを押した日時
  stopped_at INTEGER,            -- 配信が止まったと分かった日時（ここから1年で消す）
  checked_at INTEGER             -- Brevo に配信の状態を最後に問い合わせた日時
);
CREATE INDEX IF NOT EXISTS consents_email ON consents (email);
CREATE INDEX IF NOT EXISTS consents_created ON consents (created_at);

-- 週のまとめの配信（同じ週を2回作らないため）
CREATE TABLE IF NOT EXISTS campaigns (
  week TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  campaign_id TEXT,
  sent INTEGER NOT NULL DEFAULT 0,
  status TEXT,                   -- claimed / created / sent / failed
  notified INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
