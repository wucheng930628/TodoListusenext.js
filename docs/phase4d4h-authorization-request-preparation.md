# Phase 4D-4H 正式 Cutover 授權申請準備

2026-11-19 15:18:06，台北時間。正式 Cutover **NOT READY**。技術預檢通過。正式申請仍缺使用者明確授權與完整簽章 `cutover` Bundle，本輪未建立申請。

## 正式唯讀核對

| 項目 | 結果 |
| --- | --- |
| Workspace ID | `SLOWLY#WORKSPACE#cd5aa79a-3fb4-8b5c-b610-aadd79b8f49c` |
| Migration ID／Plan ID | `51684a8d9688456849e25c5e59a2119febecbb37fa4635e671dda8792cfdf197` |
| Source Namespace | `dryrun-6edab0e2-c674-4044-91a1-dbb276e8f418` |
| Backup Payload SHA-256 | `4c9b8fc3a2a1eafcd64f657eb7927298863dc485b08179323e9cef030f12cbc7`，已重算，原檔前後相同 |
| Migration 與 Release | Session 版本 35，Session 與鎖均 `RELEASED`，10/10 Receipt `CONFIRMED`，10/10 已釋放 |
| 正式 `SlowlyTasks` | 前後仍為同一組 33 筆。正式授權控制紀錄 0 筆 |
| Workspace View | 既有 Repository 與伺服器 View 讀取 1 Workspace、2 Boards、6 Tasks、1 Widget，與備份逐欄一致，Data Fidelity 差異 0 |
| Trusted Evidence | `release-preparation` 的 HMAC-SHA256、正式身分與 Release 快照比對通過。檢查時有效至台北時間 2026-11-19 15:41:17，未更新 |
| Gate | `evidenceVerified: true`、`ready: false`、`cutoverEnabled: false`，`CUTOVER_APPROVAL_REQUIRED` |

屆時若 Evidence 已過期，先使用 [唯讀準備工具](phase4d4a-release-evidence.md) 重新產生並驗證，保留原始備份。準備用途不會產生正式授權。

## 人工確認與操作順序

Phase 4D-4G 的 Chrome 狀態與來源凍結為 `USER_CONFIRMED`。執行前仍須在原 Chrome 設定檔、原 origin、所有同站頁籤複檢 localStorage 模式、來源與備份一致且持續凍結。檢視 Task／Board／Widget 草稿、寫入中提示，以及 IndexedDB `slowly-api-recovery-v1-formal` → `operations` 是否有 `active`、Pending 或 UNKNOWN。若有異常，保留頁籤與紀錄，停止。

以下操作是待授權 Runbook，本輪均未執行。CLI 為 `node --conditions=react-server --env-file=.env.local scripts/cutover-authorization.mjs`，僅由可信任操作者在私有伺服器環境使用。設定及完整 attestation 規格見 [Phase 4D-4F](phase4d4f-cutover-authorization.md)。

| 順序 | 操作 | 預期結果 |
| --- | --- | --- |
| 1 | 使用者明確指定正式 origin、Workspace、Migration／Plan、備份指紋、唯讀範圍與有效期限，完成即時 Chrome 複檢 | 已記錄當下確認與授權範圍 |
| 2 | 操作者以有效準備 Bundle 和私人 attestation 檔執行 `review <attestations-file>` | `REVIEW`、確認指紋與效期。尚無持久化授權 |
| 3 | 受明確授權後執行 `sign <attestations-file> <review-digest>`，將私人程序的 Evidence 路徑指向完整 Bundle | `SIGNED`，排他建立私人 `cutover-approved.json` |
| 4 | 執行 `request` | `REQUESTED`，Gate 仍關閉 |
| 5 | 核對指紋，再按核准範圍執行 `approve <evidence-digest>` | `APPROVED`，Gate 仍關閉 |
| 6 | 獲准進入正式執行階段後，重新確認證據、來源及瀏覽器狀態，執行 `redeem <evidence-digest>` | 條件交易只允許一次成功並回傳 `REDEEMED`。結果不明時先用 `status` 查詢 |
| 7 | 伺服器即時複驗 Gate，並讀取指定 Workspace GET View | 須同時為 `ready: true`、`cutoverEnabled: true`，GET 為 200 且 capability 未逾期 |
| 8 | 最後由使用者手動選擇同一 Workspace，啟用唯讀 API Mode | 1 Workspace、2 Boards、6 Tasks、1 Widget 與備份一致。重整後預設回 localStorage，核對 Journal 後需手動選回同一 Workspace |

CLI 狀態操作與唯讀 GET Gate 分離。授權有期限、不可重複兌換，可撤銷。版本、範圍、證據或效期改變時停止重驗。正式業務寫入仍需另外授權，並先驗證一般 mutation Route 的伺服器逐筆授權與資料演進。

## 停止與回復

若遇到斷線、409、版本漂移或資料差異，停止新寫入，保留草稿與 Recovery Journal。取消等待不能撤銷可能已完成的伺服器提交。UNKNOWN 新增先用原 Key 與 scope 查 Receipt，確認後重讀 View。未查到 Receipt 時保留原意圖，避免重送；非新增操作須人工核對。無 Pending、UNKNOWN 或草稿後，才手動切回 localStorage 顯示。切回不會回滾 DynamoDB，原始本機資料、備份與已提交的伺服器資料均保留。

```text
AUTHORIZATION_REQUEST_READY: false
EVIDENCE_VALID: true
DATA_FIDELITY_VALID: true
PRODUCTION_AUTHORIZATION_ISSUED: false
CUTOVER_AUTHORIZED: false
CUTOVER_EXECUTED: false
```

`AUTHORIZATION_REQUEST_READY` 表示能否執行正式 `request`，須先有明確授權及完整簽章證據。 `EVIDENCE_VALID` 指唯讀複驗當下的準備 Bundle。本輪未修改正式資料、備份或瀏覽器儲存，未執行 Git 提交。
