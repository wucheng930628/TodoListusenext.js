# Phase 4D-4J Trusted Evidence 更新與 Cutover Request Readiness

2026-11-19，台北時間。**正式 Request Readiness 為 BLOCKED。** 新準備 Evidence 已簽發並通過驗證。正式資料與備份一致，仍待即時 Chrome 確認、完整 Cutover 證據與使用者明確批准。

## 正式資料唯讀結果

使用既有 Repository、Migration Service、Release Evidence 與正式 Workspace View handler，讀取 `http://127.0.0.1:9000` 的 `SlowlyTasks`。Workspace GET handler 在暫時程序設定下回傳 200。常駐伺服器設定與首頁保留原狀。

| 項目 | 結果 |
| --- | --- |
| Workspace ID | `SLOWLY#WORKSPACE#cd5aa79a-3fb4-8b5c-b610-aadd79b8f49c` |
| Migration／Plan ID | `51684a8d9688456849e25c5e59a2119febecbb37fa4635e671dda8792cfdf197` |
| Source Namespace | `dryrun-6edab0e2-c674-4044-91a1-dbb276e8f418` |
| Backup Payload SHA-256 | `4c9b8fc3a2a1eafcd64f657eb7927298863dc485b08179323e9cef030f12cbc7`，重算與 Session 綁定相符，原檔未變 |
| 正式 Table／GSI | `SlowlyTasks` 與 `SlowlyByParent` 均為 `ACTIVE` |
| Migration／Release | Session 版本 35，Session 與 Lock 均為 `RELEASED`。10/10 Receipt 為 `CONFIRMED` 且已釋放，沒有未完成 Receipt 或已記錄的 Session／Receipt 衝突 |
| Data Fidelity | **0 差異**。Workspace View Model 與備份逐欄一致，1 Workspace、2 Boards、6 Tasks、1 Widget。2 筆 Legacy Tasks 依政策排除 |
| 正式表／授權紀錄 | 33 筆 Item 前後相同。22 筆 Migration 控制紀錄，1 筆未知 Item 雜湊與歷史基準一致，正式授權紀錄 0 筆 |

## 新 Trusted Evidence

前一份 Bundle 於 15:41:17 到期。本輪沿用既有 `prepareSignedReleaseEvidence`、正式金鑰讀取及 Provider 驗證流程，使用原伺服器金鑰簽署一份新的 v2 `release-preparation` Bundle。只在既有私人目錄排他新增準備檔 `release-preparation-4d4j-1795076313417.json`，原金鑰、前一份 Bundle 與原始備份保持原樣。

| 驗證 | 結果 |
| --- | --- |
| 簽發時間 | 台北時間 **2026-11-19 16:18:33** |
| 到期時間 | 台北時間 **2026-11-19 17:18:33** |
| 驗證時間／剩餘效期 | 16:18:34，剩 **3,599 秒** |
| 簽章與綁定 | HMAC-SHA256 通過。Workspace、Migration／Plan、Namespace、Backup Fingerprint、最新 Session 版本、Manifest、Receipt、Release 與 Workspace View 快照一致 |
| 正式 Gate | `evidenceVerified: true`、`ready: false`、`cutoverEnabled: false`，原因 `CUTOVER_APPROVAL_REQUIRED` |

## Request Readiness 與人工操作

- **已通過**：正式綁定、短效準備 Evidence、Migration／Release、Receipt、備份與資料一致性。
- **NOT VERIFIED**：本輪未讀取真實 Chrome。先前 `USER_CONFIRMED` 僅證明當時狀態。沒有自動推定來源仍凍結，或 Pending Write、UNKNOWN、IndexedDB active 紀錄及草稿仍為空。伺服器的 Receipt 檢查只涵蓋已持久化的 Migration 操作。
- **BLOCKED**：正式 Request CLI 需要經審核且已簽章的完整 v2 `cutover` Bundle，含 browser、validation、dryRun、freeze 與 approval。已檢查的私人目錄沒有完整 Bundle。正式使用者授權尚未取得，準備 Evidence 無法用於提交 Request。

下一步請先在原 Chrome、原 origin、原頁籤複檢 localStorage 模式、來源與原備份一致且持續凍結，以及無 Pending Write、UNKNOWN、未儲存草稿或 Recovery Journal active。再明確批准對上述 Workspace／Plan、指定 origin、唯讀範圍及期限簽署完整證據並送出一次 CLI `request`。若準備證據屆時逾期，先按既有流程更新並重驗。正式 Request 的操作與副作用見 [Phase 4D-4I](phase4d4i-authorization-request.md)。核准、兌換及切換各自另行授權。

## 測試

- 授權 5、Trusted Evidence 11、Cutover Safety 19、React 2、API 7，共 **44 通過、0 失敗**。
- DynamoDB Local Evidence／Authorization 隔離整合 **8 通過、0 失敗**，隔離表已清理。
- `git diff --check` 與新增文件行尾檢查通過。本輪未修改程式碼。

```yaml
EVIDENCE_VALID: true
DATA_FIDELITY_VALID: true
AUTHORIZATION_REQUEST_READY: false
AUTHORIZATION_REQUEST_SUBMITTED: false
PRODUCTION_AUTHORIZATION_ISSUED: false
CUTOVER_AUTHORIZED: false
CUTOVER_EXECUTED: false
```

Evidence 狀態以複驗當下為準。首頁維持預設 localStorage。未執行正式 request、approve、redeem、Cutover、Migration、Release、Rollback 或 Git 提交。
