# Phase 4D-4E Cutover Contract 與 Recovery

## HTTP 契約

| 條件 | GET Workspace View 回應 |
| --- | --- |
| 請求未通過本機安全檢查、正式綁定未啟用，或 Workspace ID 不在配置的範圍內 | `403 FORBIDDEN` |
| 需要讀取其他 Workspace 所屬資料 | `403 OWNERSHIP` |
| 已通過 Workspace 存取檢查，伺服器配置的 Plan 找不到，或 Namespace、Release 歸屬、Session 狀態或版本不符 | `409 MIGRATION_NOT_READY` |
| Workspace View 讀取期間資料不一致或未完成 | `409 SNAPSHOT_NOT_READY` 或 `409 INTEGRITY_CONFLICT` |
| 唯讀 View 完整可讀，但 Cutover 尚未授權 | `200`，`formalCutoverEnabled: false` |

403 代表請求或 Workspace 授權範圍未通過。409 代表已通過入口檢查的 Workspace 無法和持久化狀態形成一致檢視。Plan 與 Namespace 來自私有伺服器設定。既有測試已預期 409，本輪補驗錯誤代碼及 Repository 尚未被呼叫，並校正 Phase 4D-4D 的稽核預期。正式路由、Provider 及錯誤碼映射未修改。

## 授權與 Gate

正式 `GET /api/workspaces/[id]/view` 先由 `formalWorkspaceBinding` 與 Workspace View service 檢查範圍及 Release 狀態，再交給 `formalCutoverEvidence` 和 Trusted Evidence Provider。準備 Bundle 的用途是 `release-preparation`，即使簽章及資料都通過，也會回 `CUTOVER_APPROVAL_REQUIRED`。

現有 Provider 可驗證完整 v2 `cutover` Bundle。已簽章的 subject 綁定 Workspace、Migration、Plan、Namespace、Backup Fingerprint，另含正式 Release 證據與目標版本。完整證據須附與同一 subject 綁定的 `explicit-operator-approval`、有效期限、真實瀏覽器審核、驗證報告、隔離 Dry Run 與來源凍結。Provider 以最新 Session、Receipt、目標及 View 重驗後才回傳 Gate。回傳的放行期限最多 30 秒，並受 Bundle 及各 attestation 時效約束。現有設計未消耗簽章授權，時效內可重驗，亦沒有正式簽發或一次性兌換 Route。現有 CLI 只能簽發準備 Bundle。

台北時間 2026-11-19 14:45:48 的正式唯讀複驗中，準備 Bundle 的簽章與綁定通過，效期至 **2026-11-19 15:41:17**。Gate 回傳 `evidenceVerified: true`、`ready: false`、`cutoverEnabled: false`、`CUTOVER_APPROVAL_REQUIRED`。Session 版本 35，資料差異 0，正式表 33 筆前後一致。

**使用者授權方式。** 在原 Chrome 完成即時 Pending、UNKNOWN、Journal 與草稿確認，凍結來源，明確指定 origin、Workspace、Migration／Plan、備份指紋、允許的唯讀啟用範圍與期限。正式新增、修改、刪除、排序及測試清理另行指定範圍與授權。過去的瀏覽器檢查或 Migration／Release 授權都不能作為簽發 Cutover 授權的輸入。

**最小實作方案。** 私有伺服器端簽發工具應驗證操作者的獨立授權紀錄、完整審核資料及即時 Release 版本，再簽發有期限的 v2 Bundle。若正式 Cutover 須一次性啟用，加入可撤銷的授權 ID 與伺服器持久化狀態，以條件式寫入兌換一次；重試同一 ID 應能查回同一已兌換結果。GET Gate 保持唯讀。正式寫入需由伺服器在每個 mutation 與手動重送入口驗證有效期、Workspace／操作範圍及撤銷狀態。建議明確定義一次性 Cutover 啟用與後續限時寫入授權的關係，後續寫入依交易版本與 ownership 控制，避免把 Release 快照永久當作可變資料的授權依據。此方案尚未實作或簽發正式授權。

**授權後複驗。** 由伺服器載入完整短效證據，重新呼叫正式 Provider，核對 `ready: true`、`cutoverEnabled: true` 及有效期限，再對同一 Workspace 重跑 `GET /view`，檢查 200 與 `formalCutoverEnabled: true`、`formalCutoverExpiresAt`。錯誤、差異或過期時停止，保持 localStorage。

## Reload 與 Recovery

- Reload 後目前刻意從 localStorage 啟動。Journal 存有操作時會保留 Workspace ID 與原始操作資訊並封鎖編輯。選擇其他 Workspace 恢復會遭拒。沒有未確認操作時，API 模式與 Workspace 選取也不會自動恢復，須依私人操作紀錄指定同一 Workspace，再手動啟用唯讀 API。
- Pending、UNKNOWN、草稿會阻擋切換。UNKNOWN 新增先查 Receipt，CONFIRMED 後重讀最新 View。未確認時保留原 Key、payload 與 scope，且沒有自動重送。非新增 UNKNOWN 需核對伺服器狀態。
- 409 保留草稿。確定遭拒的請求只會結束該筆已知結果的 Journal claim。結果不明的新增會保留其 Journal 並查 Receipt。恢復與切換期間會拒絕其他操作覆寫既有 Journal。
- 本輪測試先重現授權在等待持久化 Journal 期間到期而請求仍會送出的缺口。控制器現在於 claim 完成後、發送前再次套用既有正式期限檢查。到期時不送出寫入，保留草稿，只結束這筆確定未送出的 claim。手動重送沿用同一檢查。Gate 條件及 API Contract 皆未更動。
- 寫入成功後重讀 API 取得最新版本。讀取失敗或資料差異時停止新寫入，留存最新可核對的資料及診斷。若有 Pending、UNKNOWN 或草稿，先處理再顯式「切回 localStorage Mode」。兩個資料來源分開保存，切換不刪除 localStorage 或 DynamoDB，Legacy v1 不自動匯入。已提交資料的修復須另行授權。

## 剩餘阻擋

正式 Cutover 執行仍需即時瀏覽器複檢、來源凍結、明確授權，以及完整有效的 v2 `cutover` 證據。一次性兌換、正式 mutation 的伺服器端授權與寫入後版本演進流程仍待實作並隔離驗證。現有準備證據綁定 Release 時的版本和內容，正式寫入後該證據會失配。現階段可提交授權設計供審核，尚未具備正式啟用或正式寫入測試條件。

## 測試與交付狀態

| 驗證 | 結果 |
| --- | --- |
| Node、React、API、Migration、Release、Cutover Safety、Recovery、Trusted Evidence | 226 通過、0 失敗、0 跳過，含隔離 Dry Run 6 項 |
| 額外 DynamoDB Local 隔離測試 | Trusted Evidence 7、Release 13、Main UI／Safe Create 19，均通過，測試表已清理 |
| Build、修改程式 ESLint、Git whitespace | 通過 |
| 正式瀏覽器 | 沿用先前 `USER_CONFIRMED` 紀錄。本輪未操作真實 Chrome，正式切換時須重新確認 |

```text
CONTRACT_VALID: true
RECOVERY_VALID: true
EVIDENCE_VALID: true
AUTHORIZATION_REQUIRED: true
CUTOVER_AUTHORIZED: false
CUTOVER_EXECUTED: false
```

`RECOVERY_VALID` 指現有流程的隔離驗證。 `EVIDENCE_VALID` 指上述複驗當下的準備證據。本輪無正式寫入、資料來源切換或 Git 提交。
