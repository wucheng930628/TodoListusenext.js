# 明確排除 Legacy 來源

此功能只準備來源選擇及驗證，不會自動啟動 Migration、資料庫寫入或 UI 切換。

## 明確政策

多來源備份預設以 `MULTIPLE_SOURCES_REQUIRE_REVIEW` 阻擋。只有完整 Verified Backup Envelope 通過 SHA-256 與結構驗證後，才接受下列 `policies.sourcePolicy`：

```json
{
  "primary": "slowly-workspace-v2",
  "legacy": {
    "source": "slowly-board-v1",
    "action": "exclude",
    "acknowledged": true
  }
}
```

可提供穩定的 `legacy.acknowledgementId`（1–128 個英數字、`.`、`_`、`-`）區別不同人工審閱。不得用目前時間在每次重送時重新產生確認資訊。未確認、未知欄位、其他來源、其他 action、僅提供內層 Backup、同時提供 legacyBoard 還原設定，都會阻擋。`legacyBoard: null` 或 `{}` 不構成排除政策。

## Plan v2 相容性與身分

維持 Plan `formatVersion: 2`、業務 `schemaVersion: 1`。原本單來源、不帶來源政策的 Plan ID 計算方式不變。新政策啟用可識別的 `sourceBindingVersion: 1`；不會將舊 Session 原地升級或回填。舊的未審閱多來源計畫不能用來建立或恢復新政策的 Session。

新 Plan ID 雜湊包含完整 Verified Backup payload 的 SHA-256、來源 namespace、政策與確認資訊、所有來源的 Storage/Schema Version 與原始 JSON 指紋、排除摘要、原始筆數、目標筆數、目標完整 Workspace 雜湊、操作內容指紋及目標 ID。Operation ID 再綁定 Plan ID。更改任一來源或政策需要重新審閱新 Plan，不能重用舊 Operation ID。相同 namespace 的已建立 Session 仍受 MIGRATION_SOURCE 唯一性保護，不能以另一政策覆寫。

來源摘要由可信任核心解析原始 Legacy array 計算，保留來源 SHA-256，區分 `originalCounts`、`exclusionSummary` 與 Plan `counts`。不相信前端傳入的排除筆數。完整來源仍保留於原始備份；排除來源不會產生目標操作，亦不會附在 Receipt 的業務 Payload。

## Session 與資料完整性

Session 持久化 `sourceIdentity`、`sourceBinding`。Source、Manifest、Receipt 保留 `planId` 與 `sourceBindingHash`。讀取 Session 時重新驗證 Plan ID、政策、來源與 Manifest 關聯；讀取 Receipt 時核對索引、操作及來源綁定。Verify、Release、Rollback 均透過這些驗證，不可混用其他政策。完整 Session 仍受既有單 Item / Transaction 大小限制，超限會在寫入前拒絕，不會省略身分資料。

Verify 以實際遷移的 Primary Workspace 完整雜湊、筆數、父子關係及 Receipt 驗證，因此不將已審閱排除的 Legacy Task 算作遺失，但真正缺少 Primary Task 仍會失敗。Rollback 只使用本 Session 實際建立且符合 Ownership / Version 的目標清單，不處理來源備份或排除的 Legacy 資料。既有 Lock、原子 Receipt、Release 後不可 Rollback 等限制不變。

## 唯讀預覽

呼叫 `prepareDryRun(verifiedArtifact, { sourceNamespace, policies: { sourcePolicy } })` 只驗證與計算，不讀寫資料庫。Migration API 的 preview/create 可在原有 `backup` 位置傳入完整 Verified Backup，並攜帶上述政策；原本單來源內層 Backup Contract 仍受支援。CRUD API 沒有改動。

未來經另外授權執行演練時，CLI 可用 `--source-policy` 指定工作目錄與 Git 之外的政策 JSON 路徑。Resume 必須提供原政策；Checkpoint 的完整備份 Fingerprint 與 Plan ID 必須一致。新增旗標不代表已授權執行資料庫操作。

仍逐一檢查所有來源的完整性、相容 Schema，以及 Primary 的 ID、父子關係、排序、WIP、Widget presence、Timer 等既有安全條件。嚴格 Dry Run Preview 遇到未知欄位仍阻擋並要求審閱，Migration 核心可保真保留的未知合法欄位也不會因此被丟棄。報告只顯示數量、政策與雜湊，不含任務私人內容。

測試：`npm run test:source-exclusion`。只使用合成 Fixture 與 MemoryClient，不需要 DynamoDB 或真實備份。
