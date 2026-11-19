# Phase 4D-4I 正式 Cutover 授權申請準備

台北時間 2026-11-19 15:26:21。已完成唯讀預檢及 Request 範本。正式申請尚未送出，正式 Gate 維持關閉。

## 正式綁定摘要

由 `http://127.0.0.1:9000` 上的正式 `SlowlyTasks` 讀取唯一持久化 Migration Session，並由既有 Migration Service、Repository 與 Workspace View 驗證。Table 與 `SlowlyByParent` GSI 均為 `ACTIVE`。

| 欄位 | 核對值 |
| --- | --- |
| Workspace ID | `SLOWLY#WORKSPACE#cd5aa79a-3fb4-8b5c-b610-aadd79b8f49c` |
| Migration ID／Plan ID | `51684a8d9688456849e25c5e59a2119febecbb37fa4635e671dda8792cfdf197` |
| Source Namespace | `dryrun-6edab0e2-c674-4044-91a1-dbb276e8f418` |
| Backup Payload SHA-256 | `4c9b8fc3a2a1eafcd64f657eb7927298863dc485b08179323e9cef030f12cbc7`，原檔重新驗證相符 |
| Session／Release | 版本 35，Session 與鎖均為 `RELEASED`。10/10 Receipt `CONFIRMED`，10/10 已釋放 |
| Release Verification Hash | `bfa13497147f9237108113a76bfbd106aab2e85faa92f70502e77555fc42fd4c` |
| Data Fidelity | 差異 0。1 Workspace、2 Boards、6 Tasks、1 Widget |
| 正式表／授權紀錄 | 33 筆前後相同，原有未知 Item 完整雜湊與基準一致。正式授權紀錄 0 筆 |

## Evidence 與 Gate

最新 `release-preparation` Bundle 的 HMAC-SHA256、Workspace、Migration、Plan、Namespace、備份指紋、Session 版本與 Release 快照均相符。檢查時尚未到期，效期至台北時間 **2026-11-19 15:41:17**。本輪未更新 Bundle 或金鑰。若正式申請前到期，須先以既有流程更新準備證據，再重驗即時狀態。

已檢查的私人證據目錄目前沒有完整 `cutover-approved.json`。正式授權紀錄為零，因此沒有可供重用或撤銷的持久化申請。準備 Bundle 的真實 Gate 回報為 `evidenceVerified: true`、`ready: false`、`cutoverEnabled: false`，原因 `CUTOVER_APPROVAL_REQUIRED`。

## Request Only 契約與呼叫計畫

正式申請是可信任操作者的伺服器 CLI。**沒有 HTTP Request Endpoint 或 Method。** `GET /api/workspaces/[id]/view` 只讀 Gate capability，不建立授權。下方為待批准後的操作，本輪未執行。

```powershell
node --conditions=react-server --env-file=.env.local scripts/cutover-authorization.mjs request
```

CLI 依私有程序環境取得 Workspace Binding，由 `SLOWLY_FORMAL_EVIDENCE_FILE` 與 `SLOWLY_FORMAL_EVIDENCE_KEY_FILE` 讀取簽章 Bundle 及驗證金鑰。此命令沒有 Request Body 或 confirmation 參數，內部呼叫 `transition("request", { binding, signed })`。下表只描述欄位，未建立可執行 Bundle。

| Service 欄位 | 準備值 |
| --- | --- |
| `binding.workspaceId`、`migrationId`、`sourceNamespace` | 上表已驗證正式值，來自伺服器設定並與持久化 Session 核對 |
| `signed.payload.formatVersion`、`purpose`、`tableName`、`endpoint` | `2`、`cutover`、`SlowlyTasks`、`http://127.0.0.1:9000` |
| `signed.payload.subject` | 完整正式綁定，含同一 Workspace、Migration、Plan、Namespace 與 Backup Fingerprint |
| `signed.payload.release` | 最新 Release 證據，包括 Session 版本 35、Release Hash 及 View／Receipt／目標版本；正式執行前重新取得 |
| `signed.payload.backup`、`options`、`attestations` | 私人備份、來源政策與五種已審核證明。正式 attestation 尚待依人工確認及實際授權準備 |
| `signed.payload.issuedAt`、`expiresAt` | 完整 Bundle 簽發時由伺服器產生及驗證 |
| `signed.signature`、金鑰 | 私人伺服器檔案，遮蔽 |

成功時對 DynamoDB Local 發出 `TransactWriteItems`，在同一交易檢查 Release Session 的版本、狀態及綁定，再以不存在條件建立一筆 `CUTOVER_AUTHORIZATION` 控制紀錄，狀態 `REQUESTED`。紀錄包含 Evidence ID、subject、Session 版本、Release Hash、申請時間、有效期限與紀錄版本。有效期採申請後 15 分鐘與簽章證據最早到期時間的較早者。Session 作為條件檢查，不被修改。預期 CLI 回傳 `REQUESTED`。同一 Evidence 重複申請會被拒絕，並行競爭可能回 `CONFLICT`。結果不明時先用 `status` 重讀。

`approve <evidence-digest>` 才能由 `REQUESTED` 轉為 `APPROVED`。另行 `redeem <evidence-digest>` 才能兌換。Request 或 Approve 後正式 Gate 仍關閉，未核准無法兌換。兌換的 CAS 只允許一次成功。使用前重新檢查期限、證據、範圍與 Session；前端沒有可設定正式 Gate 的入口。詳見 [4D-4F 契約](phase4d4f-cutover-authorization.md)。

## 剩餘條件與下一步批准

沿用先前 Chrome `USER_CONFIRMED` 紀錄。正式操作時仍需重新確認 origin、來源凍結、與備份一致、無草稿、Pending、UNKNOWN 或 Journal active。正式 Request 需另外取得明確批准，範圍為**對上列 Workspace／Plan 準備及簽署完整證據，並執行一次 CLI `request` 以建立 `REQUESTED` 控制紀錄**。核准、兌換與首頁切換各自另行授權。若完整證據不足或即時紀錄變動，須停止。

一般業務 mutation 的伺服器逐筆授權與寫入後資料版本演進仍是正式寫入驗收的獨立阻擋。本輪未改動機制。

## 測試與結果

- 現有 Node／React／API／Migration／Recovery／Cutover Safety 測試 231 項通過。另有 1 組隔離記憶體斷言通過，核對 Request 精確綁定、Gate 關閉、未核准兌換遭拒、重複 Request 遭拒、status 回讀與非授權資料不變。
- DynamoDB Local Trusted Evidence／Authorization 隔離整合 8 項通過，測試表已清理。過期、範圍不符、Session 版本變更與只允許一次兌換均有隔離覆蓋。
- 現有 UI 與 Recovery 測試覆蓋預設 localStorage、拒絕寫入保留草稿及來源隔離。正式 Request CLI 無瀏覽器入口，本輪未開啟真實 Chrome、修改 localStorage／IndexedDB 或測試正式資料寫入。
- Build、相關程式 ESLint、`git diff --check` 與新增 Markdown 行尾檢查通過。

```text
AUTHORIZATION_REQUEST_PREPARED: true
AUTHORIZATION_REQUEST_READY: false
AUTHORIZATION_REQUEST_SUBMITTED: false
PRODUCTION_AUTHORIZATION_ISSUED: false
CUTOVER_AUTHORIZED: false
CUTOVER_EXECUTED: false
```
