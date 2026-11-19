# slowly. Phase 4 最終驗證報告

2026-11-19，台北時間。**正式 Cutover 與 Phase 5 交接驗收目前仍為 BLOCKED。** 本輪完成正式資料唯讀核對與隔離回歸，並補上正式 View 模式的業務寫入封鎖。未取得或推定 Gate A／B／C 授權。

## Phase 4 架構與已完成能力

| 層 | 已驗證能力 |
| --- | --- |
| 來源與備份 | 首頁預設 localStorage，Verified Backup 封存來源與政策。Legacy v1 保留，排除 2 筆 Legacy Tasks，無自動匯入 |
| 伺服器 | 開發 loopback API、Repository、DynamoDB Local 交易、歸屬與版本條件、父項版本／Workspace Barrier、Migration Lock |
| Migration 與 Release | Plan／Manifest／Receipt 持久化，Verify、逐筆 Release、失聯後查持久化結果 |
| Workspace View | 正式伺服器綁定 Workspace／Plan／Namespace。主表強一致重讀、父子計數與版本核對。403 表示拒絕存取，409 表示綁定、版本或資料狀態不一致 |
| React 與 Recovery | 明確來源與 Workspace 選擇，草稿／Pending／UNKNOWN 阻擋切換，IndexedDB Journal，Safe Create Idempotency-Key 與 Receipt。Reload 回預設 localStorage，未解決操作保留歸屬與意圖 |
| Trusted Evidence／Authorization | HMAC-SHA256 簽章，伺服器重驗正式快照。私有 CLI 的 Request／Approve／Redeem 分離，條件交易防重放，撤銷與過期均關閉 Gate |

既有實作與契約參考 [Migration Safety](phase4a1-migration-safety.md)、[React API 整合](phase4b2-controlled-ui.md)、[Main UI](phase4c2-main-ui.md)、[Safe Create](phase4c3-safe-create.md)、[備份與 Dry Run](phase4d1-backup-dry-run.md)、[Release](phase4c1-release-readiness.md)、[Cutover 安全](phase4d2b-cutover-safety.md)、[Recovery Runbook](phase4d4d-final-cutover-audit.md)及 [正式授權](phase4d4f-cutover-authorization.md)。

## 正式資料與 Gate A 範圍

在台北時間 16:30:23 使用正式 Repository、Migration Service、Workspace View service 與準備 Evidence Provider 唯讀重驗。正式表於複驗前後完全一致，未知 Item 的完整雜湊與基準相符。

| 項目 | 結果 |
| --- | --- |
| Endpoint／Table／GSI | `http://127.0.0.1:9000`／`SlowlyTasks`／`SlowlyByParent`，Table 與 GSI 均 ACTIVE |
| Workspace | `SLOWLY#WORKSPACE#cd5aa79a-3fb4-8b5c-b610-aadd79b8f49c` |
| Migration／Plan | `51684a8d9688456849e25c5e59a2119febecbb37fa4635e671dda8792cfdf197` |
| Namespace | `dryrun-6edab0e2-c674-4044-91a1-dbb276e8f418` |
| Backup Payload SHA-256 | `4c9b8fc3a2a1eafcd64f657eb7927298863dc485b08179323e9cef030f12cbc7` |
| Session／Receipt | 版本 35，Session 與 Migration Lock 均 RELEASED，10/10 CONFIRMED 且釋放 |
| Workspace View | 1 Workspace、2 Boards、6 Tasks、1 Widget。Data Fidelity 0，原備份未變 |
| 正式 Item | 33 筆，含 10 業務、22 遷移控制、1 原有未知 Item，正式授權 0 筆 |
| Evidence／Gate | 準備證據的 HMAC-SHA256、範圍、Session 與 Release 快照通過。複驗時有效至台北時間 **2026-11-19 17:18:33**，未重簽。Gate 為 `evidenceVerified: true`、`ready: false`、`cutoverEnabled: false`、`CUTOVER_APPROVAL_REQUIRED` |

Gate A 的待批准範圍是對上述 Workspace／Plan、備份、來源 origin 與有效期限，簽署經審查的完整唯讀 Cutover 證據，並透過操作者 CLI `request` 建立一筆 `REQUESTED` 紀錄。Request 不允許寫入業務資料或切換首頁。完整簽章證據、當下人工複檢與使用者授權仍缺，請先補齊，不得提交。既有方案見 [Request 契約](phase4d4i-authorization-request.md)與 [Evidence Readiness](phase4d4j-request-readiness.md)。若準備證據到期，先以既有準備流程續發並重驗。

## 本輪補強及仍待驗收

- 正式 View 設定下，普通業務 mutation 請求在存取 Repository 前回 403。Workspace View 明確回傳 `formalRuntimeWritesEnabled: false`，首頁亦拒絕寫入及重送。即使唯讀 Cutover 的 capability 未來有效，也不能用它代替正式作業寫入授權。
- 伺服器的版本衝突 `409 CONFLICT` 保留草稿及上一份已確認 View，並撤回寫入能力。重讀後須明確重新授權。WIP 等已知輸入拒絕保持既有修正流程。
- 移除 Analytics Hook 相依表達式警告，仍在載入狀態轉換時重新安裝 ResizeObserver。三個既有 WorkspaceBoard Lint errors 保留。兩個涉及原本 localStorage hydration／持久化錯誤顯示時序，一個涉及首頁原生導覽的整頁重載與離頁保護。本輪保留這些行為，Lint 規則未停用。
- 既有正式唯讀 View 可在允許的 staging 設定下手動讀取。正式業務寫入目前被封鎖。後續需完成逐筆伺服器端 runtime 授權及撤銷，定義合法寫入後的授權與版本演進，並以隔離 CRUD 驗證後再申請正式寫入驗收。已綁定 Release 快照的 Evidence 會對合法資料變更失配，不能直接作為長期寫入權限。
- 原 Chrome 的驗收與來源凍結沿用先前 `USER_CONFIRMED` 歷史紀錄。本輪未存取真實資料。正式操作前須在原 origin、原頁籤複檢 localStorage 與備份一致、資料來源凍結、無草稿、無 Pending／UNKNOWN，且 IndexedDB Recovery Journal 無 active。隔離 Chrome 結果另列於測試紀錄。

## 正式停止與 Recovery

Gate A 先取得明確批准才執行 Request；Gate B 分別確認核准及兌換；Gate C 取得獨立執行批准，並先重驗資料、有效 Gate 及 Chrome 狀態。任何階段出現不一致即停止。正式唯讀切換後，須核對完整 Workspace View 與重整後顯示。Reload 目前回到 localStorage，使用者須在確認 Journal 後手動選回同一 Workspace。

遇到斷線、409 或資料差異，先停止新寫入，保留草稿、Journal、原 Operation Key、payload、scope 和 Receipt。UNKNOWN 新增先查 Receipt，確認後重讀最新 View。未確認時不自動重送。待所有待處理狀態安全解決後才手動切回 localStorage 顯示。切回保留 DynamoDB 已提交資料，原備份另行保存。已 RELEASED 的 Migration 不走自動 Rollback。

## 交接狀態

Phase 4 仍缺正式執行授權、切換及正式 CRUD 驗收與寫入授權模型。不得宣告 Phase 4 完成或 Phase 5 正式就緒。參閱 [Phase 5 交接](phase4-to-phase5-handoff.md)。

## 測試紀錄

| 驗證 | 結果 |
| --- | --- |
| Node／React／API／Migration／Release／Cutover／Recovery | 233 通過，0 失敗，含隔離 Dry Run 6 項 |
| 額外 DynamoDB Local 隔離整合 | Evidence／Authorization 8、Release 13、Migration 14、Controlled UI 6、Main UI／Safe Create／Next HTTP 20。合計 61 通過。測試表已清理，正式表快照一致 |
| 真實 Chrome 隔離驗收 | 8/8 PASS，Chrome 157.0.8103.51，run `e29fa6c4-b95f-4918-824e-e4d1fe4153e4`。實際重整、恢復與 HTTP 409，驗證衝突後寫入撤回、重讀及明確授權。專用 profile 與伺服器已清理 |
| Build、修改程式 ESLint、Git whitespace | 通過。全專案 ESLint 仍有上述 3 errors、0 warnings |

第一輪瀏覽器 runner 在 React／DynamoDB 預檢因既有劇本直接寫入而停止。加入衝突後的唯讀斷言、重讀與重新授權後，改用全新隔離表重跑通過。真實使用者 Chrome 狀態未由本輪驗證。舊入口中會寫入正式表的測試未執行，相關交易與 CRUD 改由隔離入口驗證。

```text
PHASE4_TECHNICAL_PREPARATION_COMPLETE: false
EVIDENCE_VALID: true
DATA_FIDELITY_VALID: true
AUTHORIZATION_REQUEST_READY: false
AUTHORIZATION_REQUEST_SUBMITTED: false
PRODUCTION_AUTHORIZATION_ISSUED: false
CUTOVER_AUTHORIZED: false
CUTOVER_EXECUTED: false
PRODUCTION_API_MODE_ENABLED: false
PHASE4_COMPLETE: false
PHASE5_READY: false
```

Evidence 有效性以複驗當下為準。本輪正式資料、原始備份及真實瀏覽器儲存未修改。僅查詢 Git，未 Commit、Push 或 Merge。
