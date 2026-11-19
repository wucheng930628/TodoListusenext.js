# Phase 4D-4G 正式 Cutover 最終預檢

2026-11-19，台北時間。**正式 Cutover 仍為 NOT READY。** 本輪唯讀檢查正式資料，授權狀態轉換與寫入測試只執行於隔離環境。正式首頁仍預設 localStorage。

## 正式資料與 Evidence 唯讀結果

於 15:03:55 使用既有正式伺服器端 Repository、Migration Service、Release Evidence 與 Workspace View GET handler 核對 `http://127.0.0.1:9000` 的 `SlowlyTasks`。使用暫時程序設定直接呼叫既有 handler，未變更常駐伺服器及首頁。

| 項目 | 結果 |
| --- | --- |
| 正式資料 | 33 筆前後完全一致。1 Workspace、2 Boards、6 Tasks、1 Widget，22 筆 Migration 控制紀錄，1 筆原有未知 Item |
| 原有未知 Item | 完整雜湊與既有基準一致 |
| Migration／Release | Session 版本 35，Session 與鎖均 `RELEASED`，10/10 Receipt `CONFIRMED`，10/10 已釋放 |
| Workspace View／Data Fidelity | 正式 GET handler 回傳 `200`。View Model 與 Primary 備份逐欄、排序、關聯與設定一致，差異 0 |
| Workspace ID | `SLOWLY#WORKSPACE#cd5aa79a-3fb4-8b5c-b610-aadd79b8f49c` |
| Migration／Plan ID | `51684a8d9688456849e25c5e59a2119febecbb37fa4635e671dda8792cfdf197` |
| Source Namespace | `dryrun-6edab0e2-c674-4044-91a1-dbb276e8f418` |
| 原始備份 Payload SHA-256 | `4c9b8fc3a2a1eafcd64f657eb7927298863dc485b08179323e9cef030f12cbc7`，已重算。原始檔未變，2 筆 Legacy Tasks 依政策排除 |
| HMAC-SHA256／Evidence 綁定 | 簽章、Workspace、Migration、Plan、Namespace、備份指紋、Session 與 Release 快照均相符 |
| Evidence 期限及用途 | 複驗當下有效，到期為台北時間 **2026-11-19 15:41:17**。用途為 `release-preparation`，尚缺正式授權用途的完整 attestation 與兌換紀錄。未發行新 Bundle |
| 正式授權紀錄 | 0 筆 `CUTOVER_AUTHORIZATION` 控制紀錄 |

正式 Readiness Gate 真實回報為 `evidenceVerified: true`、`ready: false`、`cutoverEnabled: false`，blocker 為 `CUTOVER_APPROVAL_REQUIRED`。準備 Bundle 分支會先停止，尚未對正式完整 Cutover 證據的全部 attestation 執行放行驗證。若 Bundle 屆時逾期，需重新產生及驗證準備證據。本輪未執行重簽、申請、核准、兌換或撤銷。

## 授權機制預檢

正式介面是可信任操作者的伺服器 CLI 與既有唯讀 Workspace View Gate。狀態由資料庫保存，沒有瀏覽器可呼叫的授權 POST Route。詳細介面見 [Phase 4D-4F](phase4d4f-cutover-authorization.md)。

| 項目 | 隔離驗證 |
| --- | --- |
| 申請、核准 | 同一份完整 Evidence 才能進行狀態轉移。核准需明確確認指紋，單獨核准不會開啟 Gate |
| 一次性兌換、重放、競爭 | 同一 Evidence 的兩個並行請求只有一個成功。後續兌換拒絕，交易比對授權版本與正式 Release Session 版本 |
| 狀態與撤銷 | 新 Provider／Workspace View 可讀回持久化狀態。撤銷後 Gate 拒絕，原紀錄保留 |
| 過期及錯誤範圍 | Evidence 到期、授權紀錄獨立到期、Workspace／Plan／Evidence 不符、Session 變動、Release 未完成與缺少瀏覽器狀態證明均拒絕 |

`AUTHORIZATION_SYSTEM_READY` 指程式與隔離驗收通過。正式操作者仍須準備經審核的 v2 `cutover` 證據，取得明確授權後才可執行正式流程。

## 真實 Chrome 人工驗收清單

本輪未操作真實 Chrome 或瀏覽器儲存。先前 `USER_CONFIRMED` 是歷史紀錄；正式操作前須在原 Chrome 設定檔、原 origin、原頁籤重新確認。

1. 確認首頁資料來源為 **localStorage**。保留開啟的頁籤，確認原始看板、任務、Widget 內容與備份一致。
2. 檢視同 origin 各頁籤及開啟的 Task／Board／Widget 表單。確認無寫入中、結果未確認或未儲存草稿。若顯示「檢視未儲存草稿」，確認清單為空。
3. 用 DevTools **Application → IndexedDB → slowly-api-recovery-v1-formal → operations** 唯讀確認沒有 `active`、Pending 或 UNKNOWN。Journal 無法讀取也視為未通過。遇到異常保留頁籤與紀錄，暫停切換。
4. 確認原始 JSON 備份仍可讀，用原網站備份驗證頁驗證 Payload SHA-256。伺服器已核對檔案，但當下的瀏覽器資料仍需人工判斷。備份與現況不同時保留原檔，另行審查差異。
5. 停止所有相關頁籤編輯，確認來源已凍結。記下 origin、Workspace、Plan 及時間，確認可依下方 Runbook 回到本機顯示。

## 切換與 Recovery Runbook

1. 先完成上述人工驗收。取得使用者對指定 origin、Workspace／Plan、備份指紋、有效期與唯讀切換範圍的**明確正式授權**。完整證據只能由可信任操作者在授權後簽發、申請、核准。正式兌換及首頁切換為獨立操作，本輪均未授權。
2. 授權後按 4D-4F Runbook 重新驗證簽章、即時狀態、Gate `ready: true`、`cutoverEnabled: true` 與 Workspace GET 的有效 capability。再由使用者手動進入指定 Workspace 的唯讀 API Mode，核對 2 Boards、6 Tasks、1 Widget、欄位、排序與版本。重整預設回 localStorage，當空白 Journal 與草稿條件通過時，手動選回同一個 Workspace 並重查資料一致性。
3. Pending 等待結果。斷線或取消等待可能已提交，保留 Journal 與原 Key／payload。UNKNOWN Create 先查原 Receipt，確認後重讀最新 View。NOT_FOUND 仍未確認。Reload 不會自動 Create。非新增操作結果不明時，以伺服器實際狀態人工核對。
4. 409 會拒絕衝突操作、保留草稿，並維持既有已確認資料。現有程式對已知拒絕的一般 409 未一律撤銷整個 Workspace 的寫入權限；操作者須停止後續寫入、保留診斷及草稿，再用最新版本對照。API 失敗不會以 API 資料覆蓋 localStorage。
5. 無 Pending、UNKNOWN 與草稿後才明確切回 localStorage 顯示。兩個資料來源及原始備份都保留。若 API 已有更新，先分別備份及比對，DynamoDB 已提交資料不因切回而還原。正式資料修復需另行授權。

## 剩餘阻擋

- 真實 Chrome 即時驗收與來源凍結仍待使用者確認。
- 正式 Cutover 未獲授權。缺完整 v2 `cutover` 證據及有效的正式兌換紀錄。準備證據若到期，須重新產生。
- 一般業務 mutation Route 的逐筆正式伺服器授權，以及正式寫入後資料版本演進仍屬正式寫入前的獨立阻擋。正式業務寫入或測試須另行批准並先驗證上述能力。

## 測試與交付狀態

| 驗證 | 結果 |
| --- | --- |
| Node／React／API／Migration／Release／Recovery／Cutover Safety／Trusted Evidence／Authorization | 231 通過、0 失敗，含 6 項隔離 Dry Run |
| 額外 DynamoDB Local 隔離整合 | Evidence／Authorization 8、Release 13、Main UI／Safe Create 19，合計 40 通過。測試表已清理，正式表快照一致 |
| Build、相關程式 ESLint、`git diff --check` | 通過 |
| 全專案 ESLint | 既有 3 errors、1 warning。兩個 effect 內 setState 與一個首頁連結規則在 `workspace-board.js`，一個 Hook 相依警告在 `task-analytics.js` |

本輪只新增本稽核文件。未寫入正式資料、未變更真實瀏覽器儲存、未簽發正式授權、未執行 Cutover 或 Git 提交。

```text
FINAL_PRECUTOVER_AUDIT: BLOCKED
DATA_FIDELITY_VALID: true
EVIDENCE_VALID: true
AUTHORIZATION_SYSTEM_READY: true
BROWSER_ACCEPTANCE_REQUIRED: true
PRODUCTION_AUTHORIZATION_ISSUED: false
CUTOVER_AUTHORIZED: false
CUTOVER_EXECUTED: false
```

`EVIDENCE_VALID` 指準備 Bundle 於本輪核對時間有效。執行前仍須以當時的證據及狀態重新驗證。
