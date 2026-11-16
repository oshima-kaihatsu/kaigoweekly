@echo off
rem 毎週の自動更新（Windows タスク スケジューラから呼ぶ）。前の週（月〜日）を対象に run-week.mjs を動かす。
rem 照合に合格した記事が1本以上あれば、kaigoweekly.jp へ自動で公開する（2026-11-13 経営者承認）。送信はしない。
rem 結果と失敗（Claude Code や Cloudflare のログイン切れを含む）は tools\news\logs に残り、失敗はタスクの終了コードにも出る。
chcp 65001 > nul
cd /d "%~dp0..\.."
if not exist "tools\news\logs" mkdir "tools\news\logs"
echo [%date% %time%] start >> "tools\news\logs\scheduled.log"
node tools\news\run-week.mjs >> "tools\news\logs\scheduled.log" 2>&1
set RC=%errorlevel%
echo [%date% %time%] end (exit %RC%) >> "tools\news\logs\scheduled.log"
exit /b %RC%
