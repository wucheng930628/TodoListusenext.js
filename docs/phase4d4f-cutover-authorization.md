# Phase 4D-4F 正式 Cutover 授權與一次性兌換

本輪實作授權流程，並以合成證據與獨立 DynamoDB Local 表驗證。正式 Workspace 本輪沒有簽發、申請、核准或兌換授權。正式首頁仍預設 localStorage。

## 架構及安全邊界

既有正式 Workspace Binding、HMAC-SHA256 Trusted Evidence Provider、Migration Service、Readiness Gate 與首頁控制器共同使用。正式 Gate 新增一道伺服器端檢查，要求完整 v2 `cutover` Bundle 對應的授權已持久化並兌換。Gate 仍重新讀取已釋放的 Session、Manifest、Receipt、資料及 Workspace View。準備用途 `release-preparation` 維持 `CUTOVER_APPROVAL_REQUIRED`。

授權紀錄用完整 canonical payload 的 SHA-256 指紋作為固定 ID，綁定 Workspace、Migration／Plan、Source Namespace、備份指紋、Session 版本、Release Verification Hash 與整份證據。任何修改都會產生不同 ID，原紀錄無法套用到修改後的 Bundle。指紋用於確認操作，沒有 bearer token 功能。金鑰及 Bundle 存於伺服器私人位置，從未傳給瀏覽器。

申請、核准及兌換只能從可信任的操作者程序執行。CLI 要求既有正式 loopback 設定，拒絕隔離開關，並限定 `SlowlyTasks`。資料庫交易的 Put 只能寫授權控制紀錄，Session 項目只允許作為條件檢查。沒有新增瀏覽器可呼叫的授權 POST Route。

## API Contract 與一次性狀態

| 操作 | 必要輸入與效果 |
| --- | --- |
| CLI `review <attestations-file>` | 讀取有簽章的準備 Bundle、私人 attestation 檔及即時正式資料。顯示確認指紋、範圍與效期 |
| CLI `sign <attestations-file> <review-digest>` | 操作者核對並輸入完全相同的指紋後，排他建立私人 `cutover-approved.json`。不建立授權紀錄 |
| CLI `request` | 使用已簽章的完整 Bundle，重驗條件後建立 `REQUESTED` 紀錄 |
| CLI `approve <evidence-digest>` | 明確確認指定紀錄，條件式由 `REQUESTED` 變更為 `APPROVED` |
| CLI `redeem <evidence-digest>` | 重新驗證全套條件，在同一交易比對 Session 版本、Release 狀態及授權版本，由 `APPROVED` 變更為 `REDEEMED` |
| CLI `status` | 一致性唯讀查詢同一 Bundle 的狀態及到期時間，供結果不明時查證 |
| CLI `revoke <evidence-digest>` | 條件式轉為 `REVOKED`，保留紀錄以拒絕重放 |
| `GET /api/workspaces/[id]/view` | 沿用 200／403／409 契約。唯讀、無副作用。符合 Gate 時才回傳 `formalCutoverEnabled: true` 及短效期限 |

操作者使用 `node --conditions=react-server --env-file=.env.local scripts/cutover-authorization.mjs <action> ...`，正式 Workspace 與 Evidence 設定透過私人伺服器程序環境配置。沿用 [Phase 4D-4A 私人設定說明](phase4d4a-release-evidence.md)。切換 CLI 的 `SLOWLY_FORMAL_EVIDENCE_FILE` 至簽發檔案後才進行 request 與後續狀態操作。以上指令本輪未對正式環境執行。

每份 Evidence 最多只有一筆狀態紀錄。申請有效期以所有簽章證據的最早到期時間與申請後 15 分鐘之較早者為準。核准及兌換不會延長期限。DynamoDB CAS 保證只會有一個並行兌換成功。重複兌換、範圍不符、逾期或 Session 改變時拒絕。撤銷後若需重新申請，須複驗並簽發新 Evidence，原紀錄保留。兌換完成後，Gate 可於有效期內反覆唯讀複驗同一持久化紀錄。GET 不會消耗授權或觸發切換。

## Gate 與人工確認

完整證據須保留既有五種 attestation。各項均須具有正確 `kind`、`provenance`、相同 `subject`、`issuedAt` 與 `expiresAt`。日期以 Unix 毫秒為單位。既有 Provider 定義 browser 的八項 PASS 與審核檔案雜湊、validation 的通過／失敗數與檔案雜湊、cleaned Dry Run 報告、來源凍結及明確操作者授權。正式 `approval` 另須有 `browserState`，由操作者確認 `pendingWrite`、`unknownOperation`、`unsavedDrafts` 均為 false，`recoveryJournalClear` 與 `sourceMatchesBackup` 均為 true。這是簽章的人工當下確認，首頁仍會以實際瀏覽器的 Journal、Pending 與草稿進行執行前保護。

要取得 `ready: true`、`cutoverEnabled: true`，除實際兌換紀錄外，必須通過即時正式 Workspace Binding、RELEASED Session 與解除鎖、全部 CONFIRMED Receipt、完整 View 及零差異 Data Fidelity。Capability 最多 30 秒，亦受授權及 Evidence 最早到期時間限制。新程序與重整可重新讀取有效的伺服器授權。首頁重整仍先以 localStorage 啟動。

## 正式 Runbook 與失敗回復

1. 在原 Chrome、原 origin 及原本頁籤唯讀複檢 Pending、UNKNOWN、Journal active 與所有草稿。核對原始備份和 Source Namespace、Plan、Workspace，並凍結來源。若資料已變，停止並交付差異審查。
2. 取得使用者對上述精確範圍與期限的明確 Cutover 授權，再由可信任操作者整理瀏覽器審核、測試、隔離 Dry Run 與凍結證據。使用 review 核對範圍，按 CLI Contract 逐步簽發、申請及核准。在另外決定進入執行階段時才兌換。核准或兌換都不會自動改變首頁來源。
3. 兌換後由伺服器重新取得 Gate，並核對正式 Workspace View 的 200、capability 與期限。確認仍然沒有 Pending、UNKNOWN 或草稿。只有取得有效結果後，才由使用者在首頁填入正確 Workspace 並手動啟用唯讀 API Mode。以原備份與 Workspace View 比對。重整後需再次手動選同一 Workspace。
4. 簽章、版本不符、過期、撤銷、競爭衝突、斷線及資料差異時停止。兌換回應不明時先用 status 重讀持久化狀態。保留 localStorage、備份、草稿及 Recovery Journal。UNKNOWN 先查 Receipt 並重讀最新 View，已提交的 DynamoDB 寫入留在伺服器端。只有沒有 Pending、UNKNOWN 或草稿時才手動切回 localStorage 顯示。
5. 本輪的兌換授權供 Cutover Gate 使用。一般 mutation Route 的逐筆正式授權與 Release 後資料演進仍是正式寫入前的獨立阻擋。目前 Evidence 綁定於已驗證的 Release 快照，目標版本或內容改變會使證據失配。正式業務寫入、測試清理或伺服器資料修復須另行授權並先解決上述問題。

## 驗證結果

| 項目 | 結果 |
| --- | --- |
| Node／React／API／Migration／Release／Cutover Safety／Recovery／Trusted Evidence | 231 項通過，0 失敗、0 跳過。含新增授權測試 5 項與隔離 Dry Run 6 項 |
| DynamoDB Local 隔離驗證 | Evidence／一次性兌換 8 項，Main UI／Safe Create 19 項均通過。測試表已清理 |
| 授權案例 | 並行只成功一次、重放拒絕、到期、撤銷、Workspace／Plan／Evidence 不符、Session 版本衝突、Release 未完成及缺少瀏覽器狀態確認均已驗證 |
| Recovery | 新 Provider 與 View 讀回持久授權，瀏覽器重整維持 localStorage 預設。未授權時保留草稿，API 失敗時沒有以 API 回應覆蓋 localStorage |
| Build／修改程式 ESLint／Git whitespace | 通過。Main UI 隔離測試仍有既有 React `act(...)` 警告 |

本輪未使用真實瀏覽器、正式操作者 CLI 或正式授權。隔離 Main UI runner 的正式表前後雜湊一致。

```text
AUTHORIZATION_IMPLEMENTED: true
AUTHORIZATION_TESTED: true
PRODUCTION_AUTHORIZATION_ISSUED: false
CUTOVER_AUTHORIZED: false
CUTOVER_EXECUTED: false
```
