# 受付の仕組み（相談フォーム・ご要望）

- サーバー側：`worker/index.js`（Cloudflare Workers）。設定は `../wrangler.toml`。表：`schema.sql`。
- 受け取った内容は D1（データベース `kaigoweekly`）に保存し、運営者のGmailにお知らせを送る。
- 保存期間（プライバシーポリシーと同じ）：相談は返答が終わってから1年、ご要望は受け取ってから1年。毎日3時に自動で消す。返答の記録がない相談も、受け取ってから2年で消す。

## 返答が終わったら（Claudeに頼めばよい）

```
npx wrangler d1 execute kaigoweekly --remote --command "UPDATE contacts SET replied_at = strftime('%s','now')*1000 WHERE id = '受付番号'"
```

## 削除の依頼が来たら（7日以内）

```
npx wrangler d1 execute kaigoweekly --remote --command "DELETE FROM contacts WHERE email = 'アドレス'"
npx wrangler d1 execute kaigoweekly --remote --command "DELETE FROM voices WHERE email = 'アドレス'"
```

Gmailに届いたお知らせのメールも消す。

## Gmailのお知らせの整理

保存期間を過ぎた受付は毎日3時に自動で消え、そのとき「【整理】保存期間を過ぎた受付○件を消しました」というメールが届く。メールにある受付番号をGmailで検索し、出てきたお知らせのメールを消す（受付番号ごとに検索するので、期限前のメールを消すことはない）。

## 個人情報が書かれていたら

相談内容・ひとことに応募者や職員の個人情報が書かれていたら、その行の該当部分を消す（Claudeに受付番号を伝えて頼む）。Gmailのお知らせも消す。
