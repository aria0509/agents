# 打包與簽名（macOS）

產出 **簽名 + 公證（notarized）** 的 `Agent S.app` / DMG，可在任何 Mac 上直接開，不會有 Gatekeeper 警告。

設定檔：`electron-builder.yml`（`hardenedRuntime` + `entitlements` + `notarize`）、`build/entitlements.mac.plist`。Team ID 已寫死在設定裡：`R9J9KG7R9J`。

---

## 一次性設定

### 1. 建立 Developer ID Application 憑證
你目前只有 `Apple Development` 憑證（本機開發用，**不能公證**）。公證發佈需要 **Developer ID Application** 憑證。只有帳號的 **Account Holder** 能建（個人帳號＝你自己）。

**方法 A：網頁（不需登入 Xcode）**
1. 產生 CSR：**鑰匙圈存取 → 憑證輔助程式 → 從憑證授權要求憑證…** → 填 Apple ID email、一般名稱隨意、CA email 留空、選 **「已儲存到磁碟」** → 存出 `.certSigningRequest`。（此步會在登入鑰匙圈建立配對的私鑰。）
2. 到 **developer.apple.com/account → Certificates → ＋ → Developer ID Application** → 上傳剛才的 `.certSigningRequest` → **Download** `.cer`。
3. **雙擊** `.cer` 安裝（跟私鑰配對進登入鑰匙圈）。

**方法 B：Xcode**：Settings（⌘,）→ Accounts → 選團隊 → Manage Certificates… → ＋ → Developer ID Application（會自動產生＋安裝）。

確認（兩種方法都一樣）：
```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
# 應出現：… "Developer ID Application: PHONG LONG STEEL GROUP COMPANY LIMITED (R9J9KG7R9J)"
```

> 私鑰只在這台機器。換機/重灌前，先在鑰匙圈把該憑證**右鍵匯出成 .p12** 備份，否則得重建。

### 2. 建立 App 專用密碼（公證用）
- 到 **appleid.apple.com → 登入與安全性 → App 專用密碼 → ＋**
- 命名（如 `agents-notarize`）→ 複製產生的密碼（格式 `xxxx-xxxx-xxxx-xxxx`）

---

## 公證憑證（二選一）

把憑證放進專案根目錄的 **`.env`**（`.env` 與 `*.p8` 都已在 `.gitignore`，**絕不會被 commit**）。`pnpm package` 會自動載入這個 `.env`。

**方法 A：App Store Connect API Key（目前採用）**
到 appstoreconnect.apple.com → 使用者與存取 → 整合 → App Store Connect API 產生 Key，下載 `.p8`（放 `build/`），記下 Key ID 與 Issuer ID：
```bash
# .env
export APPLE_API_KEY="./build/AuthKey_XXXXXXXXXX.p8"   # 從專案根目錄看的路徑
export APPLE_API_KEY_ID="XXXXXXXXXX"
export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**方法 B：App 專用密碼**
```bash
# .env
export APPLE_ID="你的 Apple ID Email"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
```

## 打包

```bash
pnpm package        # 自動載入 .env → 簽名 + 公證 + 打 DMG/zip（arm64 + x64）
```

輸出在 `release/`：`Agent S-0.1.0-arm64.dmg`、`Agent S-0.1.0.dmg`（x64）、對應 zip。
公證要上傳到 Apple 伺服器，通常 **數分鐘**，屬正常。

- 想先只驗簽名、不跑公證（快，免網路，不需 `.env`）：`pnpm package:signonly`
- 憑證挑錯（你另有 iPhone Distribution / Apple Development 憑證）就明確指定：
  `export CSC_NAME="Developer ID Application: PHONG LONG STEEL GROUP COMPANY LIMITED (R9J9KG7R9J)"`

---

## 驗證

```bash
APP="release/mac-arm64/Agent S.app"

# 簽名完整
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E "Authority|TeamIdentifier|flags"
#   Authority=Developer ID Application: …  / flags 應含 runtime（hardened runtime）

# Gatekeeper 認可（公證成功才會 accepted）
spctl -a -vvv -t install "$APP"
#   → accepted，source=Notarized Developer ID

# DMG 已 staple（離線也認得公證票證）
xcrun stapler validate release/Agent\ S-0.1.0-arm64.dmg
```

---

## 疑難排解

- **`skipped macOS notarization … APPLE_ID` 未設**：忘了 export 兩個環境變數。
- **公證被拒**：查詳細 log
  `xcrun notarytool log <submissionId> --apple-id "$APPLE_ID" --team-id R9J9KG7R9J --password "$APPLE_APP_SPECIFIC_PASSWORD"`
  常見原因：某個執行檔沒 hardened runtime、或沒簽到（本設定已對 app 全簽 + 開 hardened runtime）。
- **node-pty**：`pty.node` 與 `spawn-helper` 靠 `asarUnpack` 留在 asar 外、由 builder 一起簽；`entitlements` 的 `disable-library-validation` 讓它在 hardened runtime 下能載入。若換過 Node/Electron 版本，先 `pnpm rebuild`（postinstall 會自動跑 electron-rebuild）。
- **只是自用、不想公證**：`pnpm package:signonly`（簽名版本，本機可跑；傳到別台仍會被 Gatekeeper 擋，需右鍵開啟）。
