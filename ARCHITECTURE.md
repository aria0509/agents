# ARCHITECTURE — 給接手的 AI agent

這份文件記錄架構、關鍵機制、以及**踩過的坑**。動手改之前先讀完，能省下大量重新踩坑的時間。

## 一句話

Electron 桌面 app，每個 session 在 main 行程用 `node-pty` 跑一個 `claude` CLI，用不同 `CLAUDE_CONFIG_DIR` 隔離帳號；透過 `--settings` 注入 hooks + statusLine 把 claude 的狀態/用量回報到 app 內建的 localhost HTTP server。

## 資料流

- **main 行程是唯一事實來源**。狀態存在 `electron-store`，任何變動經 `notify()` 廣播 `EVENT_STATE` 給所有 renderer；renderer 用 zustand 鏡像。
- **IPC 契約集中在 `src/shared/ipc.ts`**（invoke 方法 + 事件），型別在 `src/shared/types.ts`。改 IPC 一定改這裡，main/preload/renderer 三邊同步。
- **claude → app 的回報**走 `hook-server.ts`：注入的 statusLine/hooks 用 `curl` POST 到 `http://127.0.0.1:<port>/e/<sessionId>/<event>`，server emit `event`，`session-manager` 消費。

## 關鍵機制（都已實測）

1. **帳號隔離**：`CLAUDE_CONFIG_DIR=<dir> claude`。使用者靠 claude-switch 長期並用 4 個 profile 就是證明，不需任何 Keychain 搬移。⚠️ default 帳號（`~/.claude`）**不可**設 `CLAUDE_CONFIG_DIR`（它的 `.claude.json` 在 `~` 而非目錄內）——見 `claude-cli.ts` 的 `envFor()`。
2. **登入 shell env**：GUI 從 Finder 啟動不繼承 shell PATH，所以用 `zsh -lic env` 抓一份（`loginShellEnv()`，快取）。**必須剝除所有 `CLAUDE*/ANTHROPIC*/AI_AGENT` 變數**，否則從 claude session 內啟動 app 時，spawn 的 claude 會誤判為 nested session 而立刻 exit（零輸出、code 0）。
3. **hooks + statusLine 注入**：`writeSessionSettings()` 產生一份 `--settings` JSON（**絕不寫進帳號目錄的 settings.json**，claude-switch profile 會 symlink 共用）。SessionStart 給 `session_id` + `transcript_path`；statusLine 給 `model`/`effort`，且 **API 回應後**才有 `rate_limits`。
4. **換帳號**（限額切換 / 手動）：`session-manager.switchAccount()` = kill pty → `moveTranscript()`（用 hook 給的 `transcript_path` 算相對路徑搬到目標帳號目錄，不自己算 cwd 編碼）→ 以新 `CLAUDE_CONFIG_DIR` `claude --resume <sid>` → 可選發 continue。
5. **用量來源**：活躍 session 由 statusLine 即時提供（只有 five_hour + seven_day，**無 per-model**）；其餘由 `fetchUsage()` **本地開一個 claude TUI、打 `/usage`、刮面板文字**（session/weekly/per-model % + reset 時間，`parseUsagePanel()`），~15s 一次、各帳號並行。**不再打 `api/oauth/usage`**：該端點是非官方的，2026-07-16 曾整批漂移回傳 0%（claude 面板本身正常），也不用再碰 Keychain token / 授權彈窗。測試時用 env `AGENTS_NO_USAGE_FETCH=1` 跳過探測。
6. **信任提示自動確認**：新目錄 claude 會顯示 "Security guide / Yes, I trust this folder"，`isTrustPrompt()` 偵測後自動送 `\r`。
7. **claude TUI 的滑鼠/畫面模式**（實測 2.1.211）：啟動時只開 `?1004/2004/2031`；**送出第一則訊息後進 alt-screen（`?1049h`）並開全滑鼠追蹤（`?1000/1002/1003/1006h`）**。後果：對話中滾輪是 claude 自己重繪捲動（非 xterm scrollback，別想靠原生捲動）、xterm 會加 `enable-mouse-events` class 把游標翻成箭頭（globals.css 用 `.cursor-text .xterm…` 高特異度蓋回 `text`）、拖曳選字被挾持（設 `macOptionClickForcesSelection`，Option+拖曳可選）。**渲染用 xterm 5.5 + @xterm/addon-webgl 0.19（僅互動 terminal）**——webgl 穩定版不支援 xterm 6（6 只有 DOM renderer，claude 整屏重繪會卡），別手癢升回 6。
8. **送出訊息**：`PtyManager.submit()` = bracketed paste + **隔 ~60ms 再送 `\r`**。同一塊送出的 `\r` 會被 TUI 當成貼上的一部分吞掉，導致 UserPromptSubmit/Stop hook 不觸發。
9. **click-to-resume**：app 重開 `restoreAsExited()` 把所有 session 標為 `exited`。**關鍵：idle（沒送過訊息）的 session claude 不會留下 transcript 檔**，所以啟動時對 `transcriptPath` 做 `existsSync`，檔不在就清掉 `claudeSessionId` → 點卡片直接開全新 session（不浪費一次註定失敗的 `--resume`）。有 transcript 的才 `claude --resume` 接回原對話。萬一 resume 仍失敗（claude 在 SessionStart 前就 exit），pty `exit` handler 靠 `resuming` set 判定 → `resumeFailed()` 清掉 resume 資訊改開全新（**只走 exit 這一條路**，先前還用文字偵測 "No conversation found"，會與 exit handler 競爭把剛重開的 session 誤標 exited，已移除）。
10. **帳號登入**：未登入帳號在 settings 的 reload 按鈕變登入按鈕。`account-manager.startLogin()` 在 pty 跑 `claude auth login`，用 `extractLoginUrl()` 從 **OSC-8 超連結轉義**（`ESC]8;;<url>BEL`）抽出 OAuth URL 回傳給前端顯示。使用者貼回代碼 → `submitLoginCode()` 寫進 pty，等 pty exit 或 25s 後用 `refreshAuth()` 確認結果。dialog 關閉會 `cancelLogin()` 殺 pty。未登入帳號不進輪替（`pickWithHeadroom` 只挑 `logged_in`）、new session 帳號下拉也濾掉。
   - **不自動開瀏覽器**（`noBrowserPath()`）：claude 靠 **PATH-resolved `open`** 開瀏覽器（實測 shim 到就會被呼叫；`BROWSER` env、絕對路徑都不是）。所以登入 pty 的 PATH 前綴一個 **`open` 寫死 `exit 1` 的 shim dir**。claude 開瀏覽器失敗後**會自動退回「複製 URL + 貼代碼」流程**（redirect_uri 從 `localhost:<port>/callback` 變 `platform.claude.com/oauth/code/callback`，並印出 `Paste code here`）——正好是我們要的（URL 給前端、使用者自己開）。若哪天要「自動開＋localhost 自動回填」就把 shim 拿掉。

## 踩過的坑（血淚，務必記住）

1. **node-pty 每次 `pnpm install` 都被重建成 node ABI**，在 electron 內載入會給出壞掉的 PTY（claude spawn 後立即 exit、零輸出）。已用 `postinstall: electron-rebuild -f -w node-pty` 防。手動修：`pnpm rebuild`。這個症狀（claude 秒退、無輸出）**先懷疑 node-pty ABI**。
2. **殺 electron 用對 pattern**：進程實際路徑是 `node_modules/.pnpm/electron@.../...`，`pkill -f "node_modules/electron"` **抓不到**。用 `pkill -9 -f "Projects/agents.*[Ee]lectron"`。殘留 zombie 共用同一個 `config.json`，會互相覆蓋狀態，製造一切詭異 flaky（transcriptPath 忽有忽無、claudeSessionId 被重置等）。**先前以為是 Playwright / node-pty 的問題，其實全是 zombie。**
3. **claude TUI 的文字用游標定位碼（`\x1b[<col>G`）分隔單字，不是字面空格**。做文字偵測（信任提示、限額訊息）前必須 `stripAnsi()` 再用 `\s*`（零或多空白）的 regex，否則 `/trust this folder/` 這種帶字面空格的 pattern 會漏掉。見 `claude-cli.ts`。
4. **`electron-store.get()` 偶爾回 `undefined`**：所有 `list()` 一律 `?? []`。
5. **持久化在使用者家目錄**：`index.ts` 開頭 `app.setPath('userData', join(homedir(), isPackaged ? '.agent-s' : '.agent-s-dev'))`——packaged 用 `~/.agent-s`、dev 用 `~/.agent-s-dev`，兩份分開。electron-store 的 `config.json`（accounts / sessions / recentLaunchArgs）+ `session-settings/` + `paste-images/` 全在這底下;claude 對話 transcript 不在這（在各帳號 `~/.claude*/projects/`）。（先前放 `~/Library/Application Support/`，packaged 取 package.json 的 name `agents`、dev 改 `agents-dev` 避免大小寫撞;現統一搬家目錄。）
6. **single-instance lock**：`app.requestSingleInstanceLock()`。多開只聚焦第一個。
7. **usage API（`api/oauth/usage`）是非官方端點，已棄用**：429 嚴重，且 2026-07-16 回傳值整批漂移成 0%（claude 自己的 /usage 面板正常）——不要再回去用它。閒置帳號用量一律走「跑一次 claude 刮 /usage 面板」。

## 怎麼驗證

- **真的跑起來看**，不要只 typecheck。app 用直接啟動最可靠：`node_modules/.bin/electron .`（dev 資料目錄）。
- **Playwright 驅動**（`playwright-core` 的 `_electron.launch`）沒問題，可截圖 + 操作 UI；`scratchpad` 曾有一系列 `drive-*.mjs` 範例。注意每次跑前用上面的 pattern 殺乾淨、`rm config.json`。
- **claude 相關流程（換帳號、resume、用量探測）跑起來慢**（每個 claude 啟動 + 一次 API 來回 ~15-30s），測試要給足 timeout。
- **打包 / 簽名 / 公證**：完整流程見 **`PACKAGING.md`**。`electron-builder.yml` 已設 `hardenedRuntime` + `entitlements`（`build/entitlements.mac.plist`）+ `notarize.teamId: R9J9KG7R9J`（org 帳號 PHONG LONG STEEL GROUP，即 Developer ID 憑證所屬 team——**簽名 team、notarize team、API key team 三者必須一致**）+ `identity: Developer ID Application`。`pnpm package` 會自動載入根目錄 `.env`（公證憑證，API key 或 Apple ID 皆可，`*.p8`/`​.env` 都 gitignore）→ 簽名 + 公證 + DMG/zip；`pnpm package:signonly` = 只簽不公證（快、免網路）。
- **entitlements 為何這樣配**：hardened runtime 下 V8 要 `allow-jit` + `allow-unsigned-executable-memory`；node-pty 的 `pty.node`/`spawn-helper` 要 `disable-library-validation` 才載得進來；`allow-dyld-environment-variables` 是因為 app 會抓 `zsh -lic env`。`asarUnpack` 把 node-pty 留在 asar 外由 builder 一起簽。
- **拖拽 / 貼上檔案 + 圖片（全在 preload 統一處理）**：`preload/index.ts` 的 window `drop` + `paste` listener（capture 階段），三種都轉成「路徑」經 `onFileDrop({sessionId, paths})` → `lib/drop.ts` → `appendDraft + setFocused`（exited 卡片再 `restartSession`）。**為何在 preload**：`webUtils.getPathForFile` 只在 preload 的 File 物件上有效（跨 contextBridge 就失效）；而且 window-capture 能在 **xterm terminal 有 focus** 時也攔到（若放 renderer 的 `onPaste`，只有 input 有 focus 才會觸發——這就是「圖片貼到 terminal 不行」的原因，已移除改由 preload 處理）。paste 分兩路：`routeFiles`（Finder 複製的檔案 `clipboardData.files` 有 File → webUtils 出 path）→ 否則 `routeImage`（截圖無磁碟路徑 → `getAsFile` 拿 bytes → `invoke('savePastedImage')` 存暫存檔 → 回傳 path）。`sessionIdFor` 沿 `e.target` 往上找 `data-session-id`（card wrapper 與 standalone root 都有掛）。
- **拖放高亮 + terminal 能收**（`lib/drop.ts` 的 window `dragover`）：**設 `e.dataTransfer.dropEffect='copy'`**，否則真實拖檔到 xterm 上游標是「禁止」、drop 根本不觸發（這就是「拖不到 terminal」的原因；CDP `dispatchDragEvent` 會**繞過**這個游標判定所以測不出來）。同時沿 `e.target` 找 `data-session-id` 寫進 `store.dragOverId`，卡片據此顯示 ring + 「拖放」overlay；`drop`/離開 window 時清掉。
- **驗證**：真實 Finder 拖檔 headless 測不了游標，但 **CDP `Input.dispatchDragEvent`（`data.files:[realPath]`）** 能送真實路徑進去驗 webUtils resolve + 路由；**檔案貼上**可用 `osascript -e 'set the clipboard to (POSIX file "…")'` 設好剪貼簿再按 Cmd+V 驗。**坑**：讀 input 值時 `document.querySelector('textarea')` 會抓到 **xterm 隱藏 helper textarea**（空的），要用 placeholder 找真正的 ChatInput。
- **⚠️ preload / main 改動不會 HMR**：`electron-vite dev` 只熱更 renderer，改了 `preload/` 或 `main/` **一定要整個重啟 dev server**，否則會 renderer 用新版、preload 用舊版，行為對不上（拖拽/IPC 會很像「沒生效」）。

## 目前狀態

功能大致齊全（帳號、session、限額引擎、換帳號、tray、背景執行、打包、i18n、主題、用量探測）。可能的下一步：
- session 狀態列 badge 的細節打磨、卡片迷你終端在小尺寸下的可讀性。
- 限額規則引擎的真實限額情境測試（目前靠「主動預檢用低閾值」路徑驗證，未真的撞過限額）。
- usage API 若失效，退回用 pty 輸出的限額訊息當數據源（`detectRateLimit` 已就位）。
- 簽名 / 公證：設定已就緒（見 `PACKAGING.md`），待使用者建立 Developer ID Application 憑證後即可 `pnpm package`。

## 溝通 & 編碼慣例

見 `CLAUDE.md`：與使用者用**繁體中文**；程式碼註解/命名用英文；**重視做減法與可讀性、注重性能**。
