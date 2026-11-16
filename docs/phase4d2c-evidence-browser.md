# Phase 4D-2C：Trusted Evidence 與瀏覽器驗收

本階段沒有正式 Migration／Release／Rollback／Cutover，沒有啟用正式 API Mode。正式表只做唯讀檢查；測試只建立獨立 Table。私人備份不寫入 Git、Fixture 或報告。

## 本輪瀏覽器狀態

專案及工具 runtime 均未安裝 Playwright／Puppeteer。Windows Computer Use 可發現 Chrome，並開啟新的空白無痕視窗；但取得視窗狀態時，安全機制因無法可靠確認目前 URL 而停止 Computer Use。沒有繞過限制，沒有再對瀏覽器輸入，也沒有開啟原網站或讀取真實 localStorage。

八項 Browser Acceptance 本輪均為 **NOT TESTED**，不是 PASS、亦不是產品 FAIL。沒有 Browser Trace 或 Screenshot。原生工具建立的空白無痕視窗需由使用者自行關閉；不為了清理它而停止其他 Chrome 程序。

新增的隔離驗收頁面只在 Development、明確的受控 Table／run ID、fixture ownership proof 及額外 `SLOWLY_BROWSER_ACCEPTANCE_RUN_ID` 都一致時提供，否則 404。該頁面的 DOM driver 與真實瀏覽器 IndexedDB 行為尚待人工執行，不能把編譯成功當成瀏覽器通過。

## 人工驗收：安全啟動與結束

1. 先確認 DynamoDB Local 在 `http://127.0.0.1:9000`。不要修改 `.env.local` 的正式資料來源，亦不要開啟 `http://localhost:3000` 做測試。
2. 在專案目錄，由使用者執行：

   ```powershell
   node --import ./tests/helpers/ui-module-loader.mjs scripts/phase4c2-integration.mjs --isolated-table --serve --browser-acceptance --origin http://127.0.0.1:3137
   ```

   Runner 會建立全新的 `Slowly_Phase4C2_<runId>` 與兩個合成 Workspace，列出 `OPEN`、`TEST_WORKSPACE`、`STOP_FILE`。若埠已被占用，停止並選擇其他未使用、非 3000 的 loopback 埠；不要結束不明程序。
3. 開啟新的無痕視窗，只前往 runner 輸出的 `/dev/browser-acceptance`。此來源不得有既有 localStorage；頁面若回報 `FRESH_PRIVATE_BROWSER_REQUIRED`，停止，不能清空未知資料來通過。
4. 按「執行隔離瀏覽器驗收」。第一段用受控的 client transport 模擬成功提交後 Response 遺失及 Receipt 暫時離線；並非切斷真實網路或修改 Windows 設定。
5. 出現 `RELOAD REQUIRED` 後，在這個隔離視窗重新整理。只確認本次合成草稿／Pending 的離開提示，不能操作原網站。
6. 按「繼續 Reload 驗收」。Task／Board 草稿測試會出現明確捨棄確認；只確認本次合成內容。觀察結果表，不可自行把 FAIL 或 NOT TESTED 改成 PASS。
7. 若任何一步失敗，保留頁面結果／測試 run ID，記錄實際步驟。不要執行正式修復或對真實資料重送。
8. 保存人工驗收記錄後，在另一個 terminal 對 runner 輸出的精確 `STOP_FILE` 使用 `Set-Content -LiteralPath <STOP_FILE> -Value stop`。等 runner 確認 `serverStopped:true`、`cleaned:true` 後才視為結束。不要以模糊前綴刪除 Table。
9. 關閉本次無痕視窗。不得清除原網站的 storage。若清理權限不足，保留 run report 並先確認 PID／Table ownership，不停止未知程序。

## 每項驗收與預期結果

| 檢查 | 人工觀察／預期結果 | 本輪 |
| --- | --- | --- |
| indexedDbPending | DevTools Application → IndexedDB `slowly-api-recovery-v1-isolated` → operations → active，可見原 Key、scope、Payload；請求尚未確認時不消失 | NOT TESTED |
| unknownReload | 重新整理後仍是原 Key／Payload；尚未查明時禁止新寫入，不自動開啟 API | NOT TESTED |
| confirmedRefresh | Receipt CONFIRMED 後讀取目前伺服器版本；只出現一筆 `Browser confirmed latest`，不還原舊 Create 回應 | NOT TESTED |
| draftProtection | Task／Board／Widget 輸入保留；切換來源、Workspace 或 Board 被阻擋；取消需明確確認 | NOT TESTED |
| pendingSwitch | 儲存中不能切換 Workspace／資料來源；取消等待不代表取消 server commit | NOT TESTED |
| conflict409 | 測試外部版本更新後儲存舊草稿，顯示衝突，不關閉／清除輸入，不顯示成功 | NOT TESTED |
| legacyProtection | 只在本次空白隔離來源放入合成 v1；缺少 v2 時顯示阻擋，不建立 v2、不改寫 v1 | NOT TESTED |
| sourceIsolation | API 操作不建立或修改 localStorage；切回本機時不混合 API cache；測試設定不能帶入正式首頁 | NOT TESTED |

結果頁只是未簽章的測試結果，**不是可信任 Cutover 授權**。需要人工檢視、保存證據並另行批准；本輪未發行任何正式 Browser PASS 或 Cutover 證據。

## Trusted Evidence Provider

新增 `createTrustedEvidenceProvider()`，由 server-owned dependencies 提供 bundle、驗章器、Repository、Migration Service 與強一致 Get。沒有接收前端 Request Body，ready／cutoverEnabled 不作為輸入依據。

Bundle 必須以 HMAC-SHA256 驗證，綁定 endpoint、tableName、issuedAt／expiresAt 及 subject：Workspace ID、Migration ID、Plan ID、Backup Fingerprint。使用 Node canonical JSON 與 timing-safe comparison。實際 bundle、簽章金鑰及完整 Verified Backup 必須留在 Git／工作目錄之外的私有檔案，不能成為公開測試 Fixture。

五類證據缺一不可，且各自綁定相同 subject、版本與期限：

- `browser`：由受信任操作者檢視過的真實瀏覽器證據，八項均 PASS，含 artifact hash。
- `validation`：可信任測試 runner 的通過／失敗數及 artifact hash。
- `dryRun`：相同 Plan／Fingerprint／Mapping／排除政策的隔離演練，完整 Verify／Release、零差異且已清理。
- `freeze`：明確的來源凍結確認。
- `approval`：另行給予的正式 Cutover 授權，不因測試通過而自動產生。

伺服器重新驗證完整備份與 Preview、重新計算 Plan ID，查詢實際 Session／所有 Receipt／Manifest／Verify／Release／Ownership／版本／Lock，再重讀 Workspace 與關聯資料。會拒絕缺少 Receipt、未 CONFIRMED、內容／版本改變、未 Release、舊 UI Snapshot、未管理 children 或檢查期間版本改變等情況。比對的是完整資料與 Mapping，不只是數量。

正式 Route 已接入 loader；只有另外設定 `SLOWLY_FORMAL_EVIDENCE_FILE` 與 `SLOWLY_FORMAL_EVIDENCE_KEY_FILE` 才會載入私有檔案。仍需原有 Development／Loopback／Host／Origin 及精確 Workspace／Plan binding。檔案必須為私有絕對路徑，不能在 Git worktree，且有大小限制。Provider 的 DB adapter 只允許指定 SlowlyTasks 的 Get／Query；寫入會被第二道 boundary 拒絕。沒有配置時，不讀證據檔、不查 DB，直接 NOT READY。

本輪沒有配置這些正式環境值、建立正式金鑰或簽署正式證據。測試 helper 使用隨機一次性金鑰及合成 bundle，tableName 綁定獨立測試 Table；不能被正式 loader 採用。

## 限制與下一步

Provider 是初次 Cutover 的唯讀 preflight，最多產生 30 秒有效報告，不是原子資料凍結或登入授權。使用者需維持來源凍結；正式寫入仍依 Repository 的版本／Workspace barrier。Cutover 後合法編輯不應永久要求等於原始備份，後續正式 runtime certificate／操作政策仍需明確設計與授權，不能將此初次保真檢查冒充持久化授權。

正式資料表尚無本次 Migration Session；真實瀏覽器未完成驗收，故正式 Cutover 保持 NOT READY。下一步需先完成上述人工驗收、重新確認最新來源與正式目標，再另行授權正式 Migration（建議先止於 Verify／Release Preview）、Release、證據簽署／配置與 Cutover。

## 本輪實際結果與檔案

- Node／React／Mock：214 項通過、0 失敗。新增 `npm.cmd run test:trusted-evidence`（7 項），其餘既有 16 組 scripts 均已本輪重跑。
- `npm.cmd run test:db:trusted-evidence`：7 組實際 DynamoDB Local 隔離驗證通過；證據均為合成，不是 Browser PASS。
- `phase4c2-integration --isolated-table --serve --browser-acceptance --origin http://127.0.0.1:3137`：9 組 React／DynamoDB／HTTP 驗證通過，不冒充真實瀏覽器。
- Build 通過。新增程式 ESLint 通過；全專案仍有既有 workspace-board 3 errors、task-analytics 1 warning。瀏覽器建置輸出另設 ESLint ignore，未忽略來源程式。
- 第一次 HTTP 嘗試因 Next 對目錄 URL 的 bundling 錯誤得到 500；已修正私有檔案 root 取得方式後重跑通過。第一次程序清理受權限限制而保留 Table；核對本次 PID／Next 命令／埠及 ownership proof 後，已安全停止並清理，未動正式資料。
- 本輪三張 Table 均已確認不存在：`Slowly_Phase4C2_d00774b3ead740d7b7d52da3d7f75515`、`Slowly_Phase4C2_de3eeed74c8f4e629ca0b3a4f36977d7`、`Slowly_Phase4D2C_d1980b17b1d34fdc93fc054a9d5baf5c`。兩個測試 server 均已停止。報告留在 Git ignored 的 test-runs 供稽核。
- SlowlyTasks／SlowlyByParent ACTIVE；已建模 Workspace／Board／Task／Widget 各 0，未分類既有 Item 1；本次 32 個目標／控制 ID 衝突 0，Namespace 衝突 0，Migration 紀錄／鎖 0。原有 Item 不推測歸屬、不修改。隔離 runner 前後 formal hash 一致。
- 真實備份僅唯讀重驗既有授權檔案以計算 ID 衝突，檔案雜湊不變；沒有存取真實 localStorage。正式首頁依然 localStorage 預設，沒有正式 evidence key／bundle／binding 配置，也沒有 Git Commit／Push／Merge。

新增檔案：

- `src/lib/migration/trusted-evidence.mjs`：簽章、證據身分／期限、live DB 與完整保真驗證。
- `src/lib/api/formal-evidence.mjs`：預設停用的私有證據 loader 與唯讀 DB boundary。
- `src/app/dev/browser-acceptance/page.js`、`suite.js`：受控隔離驗收頁與待人工執行的瀏覽器 driver。
- `tests/helpers/evidence-fixture.mjs`、`tests/trusted-evidence.test.mjs`：一次性合成簽章 Fixture 與 7 項測試。
- `scripts/phase4d2c-evidence-integration.mjs`：全新隔離表的 Provider 實體交易／唯讀驗證及清理。
- `docs/phase4d2c-evidence-browser.md`：本文件。

修改檔案：

- `src/app/api/workspaces/[id]/view/route.js`：接上正式 Provider，沒有開啟環境設定。
- `scripts/phase4c2-integration.mjs`：受限 loopback origin 與 browser-only run flag。
- `tests/helpers/main-ui-scenario.mjs`：使用獨立 journal，配合明確 Board 選擇。
- `next.config.mjs`、`.gitignore`、`eslint.config.mjs`：依 run ID 隔離瀏覽器編譯目錄並排除產物。
- `package.json`：新增兩個 Evidence 測試指令。
