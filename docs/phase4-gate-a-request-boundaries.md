# Phase 4 Gate A 申請與正式 Cutover 邊界

- Gate A 以 HMAC-SHA256 驗證 `cutover-request`、人工驗收紀錄和即時 Release 快照。條件交易建立 `REQUESTED`。同一份有效 Evidence digest 的並行申請回傳同一筆紀錄。
- Gate B 獨立批准 `approve <request-digest>`，再獨立批准 `redeem <request-digest>`。操作員逐次確認 digest，DynamoDB CAS 驗證 Session 版本及授權狀態。只有一次兌換成功，撤銷會關閉 Gate。
- Gate C 由使用者另行批准。伺服器驗證 `cutover-execution` 簽章、原始 Request digest、最新 Chrome 確認、Workspace、Migration、Plan、Namespace、Fingerprint、Session Version、Receipt、Verify、Release、Data Fidelity 和有效的 `REDEEMED`。正式 View 的唯讀限制另行適用。新啟用 API Mode 需要有效 Gate，同 Workspace 既有 Recovery 的 Receipt 查詢保留，未獲授權的重送仍受阻擋。

## Chrome 當次驗收

1. 在原本的 Chrome 設定檔開啟 slowly.，以 DevTools Console 的 `location.origin` 比對原始已驗證備份的 `JSON.parse(artifact.payload).sourceInfo.origin`。關閉同源其他分頁並凍結來源操作。
2. 確認首頁資料完整，沒有寫入指示，也沒有未儲存的表單草稿。
3. 在 DevTools → Application → IndexedDB → `slowly-api-recovery-v1-formal` → `operations` 唯讀確認沒有 `active`、Pending 或 UNKNOWN。若有紀錄或狀態不明，保留資料並停止。
4. 在同 origin 的 Application → Local Storage，將 `slowly-workspace-v2` 和 `slowly-board-v1` 與備份 `JSON.parse(artifact.payload).backup.sources` 中對應的 `key` 和 `raw` 逐一比對原始字串。確認缺少的 key 確實不存在。保留原始備份與儲存狀態，勿分享內容。
5. 提供精確 origin、觀察完成時間與時區、來源仍凍結的聲明、五項安全結果及指定範圍的 Request 同意。有資料變更、409 或不明結果時停止並重新查核。HMAC 簽章證實伺服器操作員審核這份人工紀錄，Chrome 狀態由使用者親自觀察。

## 正式私人輸入與指令

先準備有效 `release-preparation` Bundle。私人 attestation JSON 沿用 `browser`、`dryRun`、`freeze`、`validation` 的真實審核證據，加入 Gate A 的 `requestConsent`。所有項目的 `subject` 均為準備 Bundle 經驗證的 `workspaceId`、`migrationId`、`planId`、`sourceNamespace`、`backupFingerprint`。

| 欄位 | 依人工紀錄確認後填寫 |
| --- | --- |
| `kind`、`provenance` | `requestConsent`、`explicit-operator-request` |
| `origin` | Chrome 實測 origin，必須等於已驗證備份的 origin |
| `observedAt` | Chrome 查核時間，Unix 毫秒 |
| `issuedAt`、`expiresAt` | Unix 毫秒。簽發不得早於 preparation 或觀察時間，也不得晚於現在。到期不超過 preparation 到期或 Chrome 觀察後 15 分鐘 |
| `frozen`、`requestApproved` | 使用者明確確認後才填 `true` |
| `browserState` | `pendingWrite:false`、`unknownOperation:false`、`unsavedDrafts:false`、`recoveryJournalClear:true`、`sourceMatchesBackup:true` |

在已配置正式 Scope 的伺服器設定 `SLOWLY_FORMAL_EVIDENCE_FILE` 為準備 Bundle，`SLOWLY_FORMAL_EVIDENCE_KEY_FILE` 為對應私密金鑰。檔案放在專案外私人位置。

```powershell
node --conditions=react-server scripts/cutover-authorization.mjs review $privateAttestationsPath
node --conditions=react-server scripts/cutover-authorization.mjs sign $privateAttestationsPath $reviewedRequestDigest
$env:SLOWLY_FORMAL_EVIDENCE_FILE = $signedRequestBundlePath
node --conditions=react-server scripts/cutover-authorization.mjs dry-run
```

Dry Run 唯讀檢查同 digest 紀錄。取得 `requestEligible: true`、`state: "ABSENT"` 與使用者明確批准後，才可執行下列正式 Request。結果不明時，使用同一 Bundle 執行 `status`。

```powershell
node --conditions=react-server scripts/cutover-authorization.mjs request
```

Gate C 的私人 approval JSON 沿用 Chrome 欄位與相同 subject，重新驗收並填入 `kind: "approval"`、`provenance: "explicit-operator-execution"`、使用者實際批准的 `approved: true`、`requestEvidenceId` 及 `sessionVersion`。以原 signed Request Bundle 執行 `review-execution <private-approval-file>`，核對 digest，再執行 `sign-execution <private-approval-file> <reviewed-execution-digest>`。兩者都要求有效兌換。Gate C 已明確授權後，才配置輸出的 execution Bundle 並重新查 Gate。
