# Phase 4D-1 — Backup 與 Migration Dry Run

2026-11-15。本輪完成可驗證備份、嚴格 Preview、獨立 DynamoDB Local 表的 Migration／Verify／Release 演練與 Resume。所有執行證據都來自合成資料，真實使用者備份與副本演練仍等待使用者明確操作及確認。正式 Cutover 狀態為 **NOT READY**。

使用者已回報 Phase 4C-3 隔離首頁手動測試完成。本輪沒有自動操作真實瀏覽器，也沒有將該回報當成本輪的測試次數。

## 手動建立真實備份

1. 在 `mytodolist` 啟動原本的開發網站，使用原本存有資料的瀏覽器 profile。
2. 直接開啟「原本網站 origin + `/dev/backup`」。例如原網址是 `http://localhost:3000`，就開 `http://localhost:3000/dev/backup`。保留原本 hostname、port、protocol 與 profile；`127.0.0.1` 和 `localhost` 的 storage 不相同。
3. 此頁不掛載主看板，也沒有 mount／effect 時的 storage 讀取。勾選「我確認讀取此網址的 slowly. 本機資料並下載備份」，再按「建立並下載已驗證備份」。
4. 下載 `slowly-backup-<time>-<fingerprint>.json`，自行保存在專案、Git 與公開目錄以外的私人位置。請暫停其他頁籤的編輯，來源變動時備份會停止並提示重試。
5. 使用「驗證已下載的備份檔」選取剛才的檔案，在瀏覽器記憶體驗證 SHA-256 與原始 JSON 往返；這個選檔操作不會上傳檔案。
6. 記錄畫面顯示的 **備份 Payload SHA-256**、來源與建立時間，自行確認檔案已保存。

首頁原有「匯出完整本機備份」按鈕也已使用同一套驗證工具。獨立 `/dev/backup` 頁適合只備份原始 storage，避免為了備份而進入主看板初始化流程。頁面只在本機開發環境提供。

本輪 agent 不會替使用者勾選確認或讀取真實 storage。真實資料下一步需要使用者提供備份的私人絕對路徑、Payload SHA-256，並確認允許對該副本執行隔離 Dry Run。請提供路徑與摘要，不要將原始備份內容貼進對話或 Git。

## 備份格式與驗證

新下載檔為 `slowly-verified-backup` v1，內含原有 `slowly-workspace-backup` v1。既有 Backup 與 Migration API 的內部資料格式保留；新 Dry Run 先驗證外層，再將內層 backup 交給 Migration Plan v2。

```js
{
  format: "slowly-verified-backup",
  formatVersion: 1,
  payload: "<完整 JSON 字串>",
  integrity: { algorithm: "SHA-256", fingerprint: "<64 hex>" }
}
```

Payload 內容包含備份格式版本、application／origin／storage 來源、來源 Storage Version／宣告的 Schema Version、原 backup 建立時間、selectedSourceKey，以及兩個已知 Storage Key 的完整 `raw` JSON 字串與摘要。

- `slowly-workspace-v2` 與 `slowly-board-v1` 均按原始字串保留，包括空白、順序與未知合法欄位。
- SHA-256 的定義是 `SHA256(UTF8(payload 字串))`，涵蓋原始資料與來源 metadata。它不是對含有 checksum 欄位的整個外層檔案做 `Get-FileHash`。
- `declaredSchemaVersion: null` 表示原來源沒有這個屬性；不向原資料補入推測版本。Storage Version 仍明確記錄為 2 或 1。
- 原始來源中不支援的 Schema Version 仍留在 raw，摘要只顯示版本數字或 `UNSUPPORTED`，不把無效版本欄位的任意內容帶入報告。
- 備份只讀取這兩個 Key，不列舉其他 storage、讀環境憑證或連線 API。沿用原工具對可疑 credential 欄位的拒絕規則，沒有偷偷刪欄位後輸出。
- 備份與驗證都重新解析並比對原始字串；相容性仍由 Preview 決定。完整性指紋本身不會證明選到了正確的瀏覽器資料。

## Migration Preview

`prepareDryRun()` 重用既有 Backup validator、`migrationPlanV2()`、data-model 與來源關聯檢查，沒有建立另一套資料轉換器。

本輪嚴格檢查以下項目

| 檢查 | 行為 |
| --- | --- |
| Workspace／Board／Task／Widget／Subtask 數量 | 來源摘要、Plan、Session 與目標數量必須一致 |
| ID Mapping 與父子關係 | 依既有 parent-scoped 規則產生穩定 ID，同一 run Resume 不改變 Mapping |
| Task／Widget 排序 | 使用來源陣列位置，核對目標 position 與重讀結果 |
| 必要欄位缺漏 | 阻擋，不使用 fromFrontend 的預設值掩蓋缺漏 |
| 未知 domain 欄位 | 保留在備份，但阻擋本輪演練，等待確認；報告列類型、結構位置及數量，不記錄未知欄位內容 |
| 已定義的 generic settings JSON | 透過既有 schema 驗證並完整保存 |
| Widget config／Span／Height／Manual Size | 驗證型別與範圍，完整比對 |
| Widget 缺省與 `[]` | 保留差異；不建立預設 analytics Item |
| Timer | 保留絕對 endsAt、remaining、taskId；懸空 taskId 阻擋 |
| Subtasks／Notes／Status／Priority／Date／Time／completedAt | 保留原值、空字串與有無差異，重用既有模型驗證 |
| WIP | 原始 doing 數量超限時阻擋，不變更限制或任務 |
| Schema Version | 不支援的版本阻擋 |
| 重複 ID／JSON Key | 阻擋，避免 JSON.parse 或 Mapping 靜默覆蓋 |
| 多個來源 Key | 備份保留全部，但演練先阻擋，等待確認要如何處理舊來源；不自動忽略 archive |
| Legacy `slowly-board-v1` | 缺少明確 Board metadata 時阻擋；只有使用者另外提供且確認的 metadata 才可建立 Plan |

optional 欄位的合法缺省，例如尚未記錄的 completedAt 或 Widget manualSize，保留其缺省語意。報告內的 blockers 只含代碼與必要結構資訊，不列任務名稱、備註、原始資料或私人 ID。

## 真實備份的手動 CLI 步驟

以下指令需在 `mytodolist` 執行。先由使用者自行建立專案以外的私人目錄，再填入實際路徑與畫面上的指紋。這些是待使用者操作的流程，本輪沒有讀取該真實檔案。

```powershell
$slowlyBackup = 'C:\你的私人目錄\slowly-backup-實際檔名.json'
$slowlyFingerprint = '備份頁顯示的64字元PayloadSHA256'
$slowlyState = 'C:\你的私人目錄\slowly-dry-run-state.json'

# 純預覽，不建立 DynamoDB 表
npm.cmd run migration:dry-run -- --backup "$slowlyBackup" --confirm-backup "$slowlyFingerprint" --state "$slowlyState" --preview-only

# Preview 無 blocker，且使用者明確確認副本演練後才執行
npm.cmd run migration:dry-run -- --backup "$slowlyBackup" --confirm-backup "$slowlyFingerprint" --state "$slowlyState" --confirm-dry-run

# 中斷後維持同一檔案、指紋與 state，明確恢復
npm.cmd run migration:dry-run -- --backup "$slowlyBackup" --confirm-backup "$slowlyFingerprint" --state "$slowlyState" --confirm-dry-run --resume
```

CLI 重新計算指紋，不相信檔案或參數提供的 hash。備份與 state 必須是不同檔案，且絕對路徑位於目前 workspace 與任何可辨識的 Git worktree 之外，會檢查 realpath／symlink。沒有檔案選擇與指紋確認就停止讀取入口；沒有 Dry Run 確認就停止寫入入口。

Legacy 副本可另外指定 `--legacy-board 'C:\私人目錄\legacy-board.json'`。此檔案應由使用者明確提供 id、name、description、wipLimit 等設定。設定納入 Plan ID，Resume 時改設定會被拒絕。此選項不會更動舊 storage。

## 隔離表、Resume 與清理

runner 固定連線 `http://127.0.0.1:9000`，使用本機 dummy credentials。表名只能是 runner 自行產生的 `Slowly_DryRun_<run UUID>`，使用既有 id 主鍵及 SlowlyByParent GSI 形狀。

Repository wrapper 與 SDK middleware 都檢查每個請求的 TableName。Create／Describe／Delete／Get／Query／Transaction 全部限定本輪表；程式沒有掃描、描述或寫入既有 SlowlyTasks 的步驟。

流程如下

1. 驗證 Backup Fingerprint、來源格式與嚴格 Preview。
2. 在私人 state 檔記錄 runId、預計表名、歸屬 nonce、Fingerprint 與 Plan ID，才建立新表。
3. 新表寫入獨立歸屬證明，後續執行與清理都必須符合 runId、nonce hash、Fingerprint 與 Plan ID。
4. 重用既有 Migration Session／Manifest／Receipt／Lock，逐步註冊與執行。
5. 回應不明時讀取持久化 Receipt。尚未確認的操作停止並保留 checkpoint，供使用者明確 Resume。
6. 執行 Verify、Release Preview、受 Workspace Barrier 保護的分批 Release，再核對 Receipt／版本／Hash 與 Lock 狀態。
7. 重建 Repository／Service，重新讀取完整 Workspace；比對 restoreWorkspace 與 Main UI View Model，接著以另一組全新讀取比對。
8. 成功後驗證歸屬證明，僅刪除本輪表。原備份與私人 state／摘要保留給使用者。

`reloadConsistencyScope` 為 `fresh-repository-and-api-view-model`。這驗證全新資料層重讀的一致性，本輪沒有把真實備份接到瀏覽器或宣稱完成真實資料的 browser reload。

state 只包含控制資料、進度與摘要，不存 raw Backup、Plan operations 或 Task／Widget 內容。歸屬 nonce 不出現在 stdout。process lock 可阻止同一 state 同時執行；Resume 僅在先前 PID 確定不存在時移除相符的舊 lock，PID 仍存活或鎖資訊不明時停止。

建立表的回應或歸屬證明若不確定，必須人工審閱，不能因表名看起來像測試表就自行接管或刪除。cleanup 回應遺失可依事前已記錄的歸屬驗證狀態核對該表是否已不存在。

失敗後如決定放棄本輪副本，使用原 state 與精確 runId 清理

```powershell
npm.cmd run migration:dry-run -- --cleanup --state "$slowlyState" --confirm-cleanup '該state內的runId'
```

清理不需要重新讀備份。缺少歸屬證明時停止，不掃描或清空其他表。已清理的 state 不能重新建立同名表；重複演練需使用新的 state。

## Cutover Readiness Report

成功演練回報以下 metadata，內容不含原始資料。

- Backup Fingerprint、來源 Storage／宣告 Schema Version、Migration Plan ID。
- sourceCounts／targetCounts，包括 Subtasks。
- Verify／Release、Receipt 數量、剩餘 Lock。
- 來源與還原後 Workspace Hash、Mapping Hash、differences。
- 全新讀取一致性、恢復過的回應數量、清理結果。
- `status: "NOT READY"`、`formalCutoverAuthorized: false` 與待確認事項。

失敗報告也標示 NOT READY，列出已知來源摘要、錯誤代碼、Verify／Release 的已知狀態、目標筆數是否尚未確認、資料／歸屬差異類型及可恢復狀態，不輸出 SDK exception 詳情或欄位值。

目前**真實備份**的 Fingerprint、Source Schema、Plan ID、來源／目標筆數與差異尚未取得，因為使用者尚未交付並授權該檔案。本輪合成資料證據不可填入這些真實資料欄位。

## 本輪實際測試

| 指令 | 通過 | 失敗 |
| --- | ---: | ---: |
| `npm.cmd run test:server` | 6 | 0 |
| `npm.cmd run test:api` | 7 | 0 |
| `npm.cmd run test:phase4a` | 25 | 0 |
| `npm.cmd run test:migration` | 24 | 0 |
| `npm.cmd run test:react-api` | 21 | 0 |
| `npm.cmd run test:controlled-ui` | 6 | 0 |
| `npm.cmd run test:release` | 12 | 0 |
| `npm.cmd run test:cutover-react` | 2 | 0 |
| `npm.cmd run test:main-ui` | 15 | 0 |
| `npm.cmd run test:main-ui:react` | 7 | 0 |
| `npm.cmd run test:safe-create` | 23 | 0 |
| `npm.cmd run test:dry-run` | 18（含 7 個子測試） | 0 |
| `npm.cmd run test:backup:react` | 2 | 0 |
| Node／React 合計 | **168** | **0** |
| `npm.cmd run test:db:dry-run` | **6** | **0** |

六項 CLI／DynamoDB 測試包含參數／路徑保護、提交後遺失回應、Migration 中斷 Resume、Release 中斷 Resume、由私人檔案輸入的完整演練，以及備份指紋變更後拒絕 Resume。中斷測試也模擬已結束 process 留下的 lock。所有備份檔均由測試產生，沒有使用真實瀏覽器資料。

代表性的合成測試 run `10633d27-c19f-4ec4-b7dd-748faadf574a` 結果

| 項目 | 合成測試結果 |
| --- | --- |
| Backup Fingerprint | `ad6fff4f245d4fa62ef36cf313d254312e6a3482791e823025f01a2735dbdec6` |
| Storage／宣告 Schema | v2／原始宣告缺省 |
| Plan ID | `78d78457077e246be608a36841387b0f002a000d1b02129612ae76f698efbe51` |
| 來源／目標 | 各 1 Workspace、3 Boards、3 Tasks、2 Widgets、3 Subtasks |
| Receipt／Lock | 9 CONFIRMED／0 剩餘 Lock |
| Verify／Release | 通過／通過 |
| 完整資料比對 | Hash 相同，differences 為空 |
| 回應遺失恢復 | 1 次 |
| 私有測試表 | 已刪除 |

這個指紋只代表該合成測試，不可用來確認真實備份。測試的 `inputMode: user-selected-file` 分支也只使用合成檔案。

本輪 Build 通過，本次修改／新增的程式與測試 targeted ESLint 通過。完整 `npm.cmd run lint` 仍有既有 3 errors／1 warning，分別是 `workspace-board.js` 兩處 set-state-in-effect、一處 Link，以及 `task-analytics.js` 的 dependency warning。

沒有執行舊的真實 DB 整合腳本，因為它們會讀取 SlowlyTasks。本輪改以新 runner 與 middleware 保證全部 DB 請求僅針對獨立表。

## 修改檔案

| 狀態 | 檔案 | 用途 |
| --- | --- | --- |
| 新增 | `src/lib/client/verified-backup.mjs` | 明確 capture、完整 payload、SHA-256、重新解析與下載 |
| 新增 | `src/components/workspace-backup-tool.js` | 同意後下載與使用者選檔驗證，不掛載主看板 |
| 新增 | `src/app/dev/backup/page.js` | 本機開發備份頁面 |
| 修改 | `src/app/main-ui.js` | 原備份按鈕使用 verified artifact |
| 新增 | `src/lib/migration/dry-run.mjs` | 嚴格 Preview、表範圍、歸屬證明、完整演練與資料比對 |
| 新增 | `scripts/migration-dry-run.mjs` | 使用者確認、私人檔案、獨立表、Resume、清理與報告 |
| 新增 | `tests/dry-run.test.mjs` | 備份、Preview、保真、Receipt、Lock 與中斷測試 |
| 新增 | `tests/backup-tool-react.test.mjs` | SSR／StrictMode 零自動讀取、明確下載／選檔驗證 |
| 新增 | `tests/dry-run-db.test.mjs` | 真實 DynamoDB Local、跨 process Resume 與私人檔案入口 |
| 修改 | `package.json` | Dry Run 與新測試指令 |
| 修改 | `.gitignore` | 忽略備份與私人演練檔名，額外防止誤加 Git |
| 新增 | `docs/phase4d1-backup-dry-run.md` | 本報告與使用者操作流程 |

## 尚待確認

目前停在真實資料授權入口。下一步由使用者自行下載、保存及驗證備份，確認副本演練範圍後，再處理該實際檔案。

真實 Preview 若出現未知欄位、多個來源 Key、Legacy metadata、缺漏或不相容版本，需要逐項確認，不能自動改資料來通過。正式切換前還需要確認備份是否仍代表最新 localStorage、正式 Migration／Release 範圍、回復策略及切換授權。此報告不會啟用正式 Cutover。

本輪沒有讀取真實 browser storage、遷移真實副本、讀寫 SlowlyTasks、切換首頁預設資料來源、部署或執行 Git Commit／Push／Merge。
