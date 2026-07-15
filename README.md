# Agent S

用 Electron 打造的桌面工具，在同一台 Mac 上管理**多個 Claude Code 訂閱帳號**與**多個 session**，以櫥窗方式排列所有終端、集中處理帳號用量、限額切換與通知。

> 目前只針對 Claude Code CLI。

## 功能

**帳號**
- 每個帳號 = 一個 `CLAUDE_CONFIG_DIR`（唯一鍵）。可掃描本機 `~/.claude*` 一鍵匯入，或手動新增（名稱 → 路徑，留空預設 `~/.claude-<名稱>` → 備註）。
- 啟動時刷新全部帳號的登入狀態（`claude auth status`）與用量；備註可隨時編輯。
- 用量顯示 5 小時 / 週窗口百分比與更新時間。

**Session**
- 建立時只有工作目錄必填；帳號可留空自動選用量最低的可用帳號；限額規則、啟動參數、標題皆選填、事後可改。
- 啟動參數下拉最近用過的值（去重、最多 10 條）。
- 新目錄的信任提示（Security guide）自動確認。
- 主界面是可交互的終端櫥窗：點卡片啟用，啟用的卡片底部浮出 chat input（貼圖、拖檔、Shift/⌘+Enter 換行），點終端可直接鍵盤交互。可拖拽排序、獨立視窗開啟。

**限額切換**（達上限時，依 session 規則）
- `自動切換帳號`：切到有餘量的帳號並發 continue（換帳號 = 移動 transcript 檔到目標帳號目錄 + `--resume`）。
- `手動處理`：通知並等待。
- `等額度刷新後自動繼續`：按 reset 時間排程。

**其他**
- 選單列常駐圖標，關掉所有視窗後點它可重開。
- 退出時可選「背景執行」（保留執行中的 session，下次打開恢復）。
- 系統通知（需處理 / 完成 / 卡限額）。
- 簡繁中文 + 英文、深 / 淺色主題。

## 開發

需求：Node 22、pnpm、已安裝 `claude` CLI。

```bash
pnpm install        # 會自動 electron-rebuild node-pty（原生模組）
pnpm dev            # 啟動（dev 資料目錄與正式版隔離：agents-dev）
pnpm typecheck
pnpm package        # 打包成 mac dmg/zip（release/）
```

## 架構

前後端全 TypeScript，共用型別放 `src/shared/`。

```
src/shared          IPC 契約(ipc.ts) + 資料模型(types.ts)，main/renderer 共用
src/main            Electron 主行程
  index.ts          bootstrap、IPC handlers、tray、退出流程、背景用量探測
  claude-cli.ts     所有 claude CLI 交互(登入 env、auth、--settings 注入、
                    transcript 搬移、限額/信任提示偵測、usage API)——版本敏感細節集中處
  pty-manager.ts    每 session 一個 node-pty + 輸出環形緩衝
  session-manager.ts session 生命週期、狀態機、限額規則引擎、換帳號
  account-manager.ts 帳號 CRUD、auth、用量
  hook-server.ts    localhost HTTP，接收 claude 注入的 hooks / statusline
  usage-probe.ts    閒置帳號用量探測(短暫跑一次 claude)
  window-manager.ts 主視窗 + 獨立視窗 + tray
  store.ts          electron-store 持久化
src/preload         contextBridge 暴露 typed IPC
src/renderer        React 19 + Tailwind v4 + shadcn/ui + zustand
```

**接手這個專案前，先讀 [`ARCHITECTURE.md`](./ARCHITECTURE.md)** —— 裡面有關鍵機制與踩過的坑（node-pty、Keychain、進程管理、Playwright 驗證等），能省下大量時間。

## 已知限制

- **閒置帳號用量**：非官方 usage API 需要帳號 token。若帳號目錄有 `.credentials.json` 則直接讀；macOS Keychain 儲存的帳號改用「啟動時短暫跑一次 claude 觸發一次 API 回應」來取得（消耗極少額度）。有活躍 session 的帳號則由 statusline 即時提供，不需探測。
- usage API 為非官方端點，可能變動或觸發 429。
- 打包預設不簽名（`identity: null`）；要對外分發需自行加簽名 / 公證。
