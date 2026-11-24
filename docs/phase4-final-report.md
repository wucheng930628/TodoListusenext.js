# slowly. Phase 4 最終完成報告

2026-11-24（台北時間）。Phase 4 的正式唯讀 Cutover 已完成，可進入 Phase 5 交接。正式業務寫入仍封鎖，Phase 5 的開發及正式寫入驗收各待授權。

## 正式 Cutover 與目前存取狀態

- **歷史伺服器驗收。** 運行中的 `http://localhost:3000` 正式 Workspace View GET 回傳 HTTP 200。有效的 Execution Evidence 使伺服器回傳 `evidenceVerified: true`、`ready: true`、`cutoverEnabled: true`，同時維持 `formalRuntimeWritesEnabled: false`。API View Model 與完整 Release Workspace 雜湊相符。
- **歷史 Chrome 驗收（USER_CONFIRMED）。** 使用者在原始 Chrome 完成切換，首頁顯示「API・唯讀」，Network 正式 GET 回傳 200。確認 2 Boards、6 Tasks、1 Widget，任務內容、排序、狀態、WIP 與 Widget 設定均一致。重新整理後回到預設 localStorage，使用者再次手動啟用唯讀 API Mode 成功。切換只適用當次頁面。紀錄未提供切換後驗收的精確完成時間。
- **持久化授權。** 本次 Request Digest 為 `51070c4125a41cff2f5331fa388455f7e913a23e2d165fa32b304d225f613b11`，紀錄 ID 為同 digest 加前綴 `SLOWLY#CUTOVER_AUTHORIZATION#`。依序完成 `REQUESTED → APPROVED → REDEEMED`。Gate C 驗收來源為 `http://localhost:3000`，人工觀察時間為 `2026-11-24T15:37:17.936Z`。
- **結案唯讀複驗。** Request 與 Execution Evidence 的 HMAC-SHA256 簽章、subject 和 Request Digest 綁定相符。Execution Digest 為 `dd9c693fe2555555e7b230c6c61096c1c9e858ac601e95d048d45c70ed9cd334`。有效授權及 attestation 於 **23:50:17.056** 到期。持久化狀態仍為 `REDEEMED`，目前 `expired: true`、`ready: false`、`cutoverEnabled: false`，原因為 `ATTESTATION_MISSING_OR_EXPIRED`。歷史驗收仍有效，若需新的正式首頁切換，須按既有授權流程申請。

## 正式資料唯讀核對

| 項目 | 結果 |
| --- | --- |
| Endpoint／Table／GSI | `http://127.0.0.1:9000`／`SlowlyTasks`／`SlowlyByParent`，Table 與 GSI 均 ACTIVE |
| Workspace | `SLOWLY#WORKSPACE#cd5aa79a-3fb4-8b5c-b610-aadd79b8f49c` |
| Migration／Plan | `51684a8d9688456849e25c5e59a2119febecbb37fa4635e671dda8792cfdf197` |
| Source Namespace | `dryrun-6edab0e2-c674-4044-91a1-dbb276e8f418` |
| 原始備份 Payload SHA-256 | `4c9b8fc3a2a1eafcd64f657eb7927298863dc485b08179323e9cef030f12cbc7`。原始檔仍存在，內容完整性驗證通過 |
| Session／Receipt／Release | Version 35，Session 與 Lock 均 `RELEASED`，10/10 Receipt `CONFIRMED` 且帶 Release 紀錄 |
| Workspace View | 1 Workspace、2 Boards、6 Tasks、1 Widget。以原始備份重算 Plan，核對完整正式快照、目標雜湊、版本、歸屬與鎖定，Data Fidelity 差異 **0** |
| 正式 Item | 強一致唯讀掃描共 **35 筆**，含 10 業務、22 遷移控制、2 授權紀錄及 1 原有未知 Item。2 筆 Legacy Tasks 依既定政策排除 |
| 原有未知 Item | 當前仍有 1 筆，完整 Item 的 canonical SHA-256 為 `f81d64b8b4a291a86e7a8f26c1c3151d77dd1963276d6a0389e5ca508e62980e`。前次正式預檢已記錄與遷移前基準一致。本輪未取得該基準的原始雜湊供再次逐字比較 |

## Phase 4 實作成果

| 階段 | 成果與安全機制 |
| --- | --- |
| 4A 備份與 Migration | 版本化備份、SHA-256、來源政策與排除紀錄、Plan／Manifest、持久化 Receipt、分段驗證與 Release。原子條件與 Lock 保護資料，遇到回應不明先査持久化結果 |
| 4B 伺服器與 React | loopback API、Repository 條件交易、歸屬與版本檢查、父版本與 Workspace Barrier。Workspace View 用強一致讀取及父子計數驗證完整性 |
| 4C 主 UI 與 Recovery | 明確選擇來源與 Workspace，草稿及 Pending／UNKNOWN 阻擋切換。IndexedDB Journal、Safe Create、Idempotency-Key、Receipt 與確認後重讀。409 保留草稿並撤回寫入能力 |
| 4D 正式 Release 與 Cutover | HMAC-SHA256、短效證據、即時 Session／Receipt／Release／Fidelity 驗證。Gate A 申請、Gate B 核准及一次性兌換、Gate C 獨立人工核准。正式唯讀 GET 支援原 Chrome 的 localhost，同時維持精確 Host／Origin 與寫入封鎖 |

[Migration Safety](phase4a1-migration-safety.md) · [React API 整合](phase4b2-controlled-ui.md) · [主 UI](phase4c2-main-ui.md) · [Safe Create](phase4c3-safe-create.md) · [Recovery Runbook](phase4d4d-final-cutover-audit.md) · [Gate A 到 Gate C](phase4-gate-a-request-boundaries.md)

## 測試與驗收紀錄

| 已執行驗證 | 結果 |
| --- | --- |
| Phase 4 歷史 Node／React／API／Migration／Release／Cutover／Recovery | 233 通過，0 失敗，含隔離 Dry Run 6 項 |
| 歷史額外 DynamoDB Local 隔離整合 | 61 通過，隔離表已清理 |
| 歷史真實 Chrome 隔離驗收 | 8/8 通過，涵蓋 Reload、Recovery、409 與來源隔離 |
| localhost Guard 修正回歸 | 26 項 Node／API／授權及 8 項 DynamoDB Local 隔離整合通過，Build、修改檔案 ESLint、diff check 通過 |
| 開發控制列版面修正 | 7 項 React 測試、Build、修改檔案 ESLint、diff check 通過 |
| 正式唯讀切換後 Chrome | USER_CONFIRMED，包含實際 Network、資料與重整後再切換 |

各批測試有重疊。本輪結案未重跑完整測試。前次全專案 lint 記錄仍有 3 項既有 WorkspaceBoard errors，保留於 Phase 5 的技術債清單。

## 結案與交接

```yaml
CUTOVER_EXECUTED: true
BROWSER_ACCEPTANCE_PASSED: true
PRODUCTION_API_READ_VALIDATED: true
PRODUCTION_API_WRITE_ENABLED: false
DATA_FIDELITY_VALID: true
PHASE4_COMPLETE: true
PHASE5_READY: true
```

`PHASE4_COMPLETE` 指正式唯讀範圍完成。`PHASE5_READY` 指交接就緒，Phase 5 開發等待使用者授權。正式 CRUD、持久化來源與正式寫入驗收列入 [Phase 5 開發計畫](phase4-to-phase5-handoff.md)。本輪只更新文件並唯讀核對，未變更正式資料、原始備份或瀏覽器儲存，也未執行 Git Commit、Push 或 Merge。
