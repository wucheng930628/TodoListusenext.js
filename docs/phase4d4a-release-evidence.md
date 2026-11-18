# Phase 4D-4A 正式 Release 證據與 Workspace 綁定

正式 Workspace View 需要伺服器啟用明確的唯讀綁定。未啟用、設定缺漏、Workspace 不符、受控測試環境或請求不符合 loopback 安全檢查時，路由回傳 403。設定通過後，伺服器先核對持久化的來源綁定、Release Workspace、Session 與鎖狀態。Session、Namespace 或 Release 狀態不符時回傳 409。

## 產生與驗證

使用可由伺服器帳號獨占存取的私人目錄。在 Windows 請確認目錄 ACL，檔案權限參數無法取代 NTFS ACL。目錄、原始備份、Bundle 與金鑰皆留在 Git 和網站公開目錄之外。Bundle 內含原始備份，需以同等機密等級保管。

```powershell
node --conditions=react-server scripts/prepare-release-evidence.mjs --prepare-only <BackupFile> <PrivateDirectory> <WorkspaceID> <PlanID> <SourceNamespace> <BackupFingerprint>
```

指令固定使用 `http://127.0.0.1:9000` 的 `SlowlyTasks`。它唯讀重驗備份、Plan、Source Namespace、Session、Manifest、Receipt、Verify、Release、Ownership、鎖、目標版本、完整 View 與 Data Fidelity。通過後使用系統亂數產生 32-byte 簽章金鑰，以 HMAC-SHA256 對 canonical JSON 簽章。產物放在新建的私人子目錄，檔案一律以排他建立方式寫入。

格式 v2 的 `release-preparation` Bundle 包含固定 Endpoint 與資料表，綁定 Workspace、Migration、Plan、Namespace 與 Backup Fingerprint，並記錄 Session 版本、Release 紀錄、Verify／Manifest／View 雜湊、各目標與 Receipt 的版本。此指令產生的證據效期為一小時。Provider 使用常數時間比較驗證簽章，重新計算 Plan 並比對正式持久化資料及版本。逾期後以同一條唯讀流程重新產生。準備證據通過時，Provider 回報 `evidenceVerified: true`、`ready: false`、`cutoverEnabled: false`。

完整 Cutover 證據須另行準備。其格式 v2 用途為 `cutover`，簽章涵蓋同樣的即時 Release 證據，以及經審核的真實瀏覽器和驗證結果、同一 Plan 的隔離 Dry Run、來源凍結及明確 Cutover 授權。正式 Provider 要求 v2。既有 v1 測試契約保留給沒有正式 Namespace 綁定的通用 Provider 驗證。

## 授權後才配置的伺服器變數

| 變數 | 值的來源與用途 |
|---|---|
| `SLOWLY_FORMAL_VIEW_ENABLED` | 唯讀綁定驗證獲授權後才設 `1` |
| `SLOWLY_FORMAL_VIEW_WORKSPACE` | 已釋放 Session 記錄的 Workspace ID |
| `SLOWLY_FORMAL_VIEW_PLAN` | 重算後的 Plan ID，也是 Migration ID |
| `SLOWLY_FORMAL_VIEW_SOURCE_NAMESPACE` | 原 Plan 的固定 Namespace。伺服器核對 Session 的來源身分與來源紀錄鍵 |
| `SLOWLY_FORMAL_EVIDENCE_FILE` | 私人 Bundle 絕對路徑 |
| `SLOWLY_FORMAL_EVIDENCE_KEY_FILE` | 私人 HMAC 金鑰檔絕對路徑。以產生工具的輸出路徑配置，金鑰內容只由伺服器讀取 |
| `SLOWLY_LOCAL_API`、`SLOWLY_LOCAL_API_ORIGIN` | 現有本機開發 API 開關及精確的 `127.0.0.1` origin。唯讀綁定驗證須在受控的本機程序進行 |

設定放在伺服器程序的私人環境中，避免透過 `NEXT_PUBLIC_`、終端記錄或前端傳輸。唯讀啟用驗證需檢查指定 Workspace 可讀、其他 Workspace 回傳 403、證據有效且準備 Bundle 仍阻擋 Cutover。此驗證不改變首頁資料來源。
