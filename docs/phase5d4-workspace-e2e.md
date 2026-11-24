# Phase 5-D4 Workspace 端到端驗收

## 驗收範圍

以 Chrome 158.0.8127.38、實際 Next.js HTTP Route Handler 和 DynamoDB Local 隔離表執行。Chrome 使用一次性設定檔。測試建立的兩個 Workspace 各有兩個 Board、兩個 Task、兩個 Widget，最後透過 API 逐層刪除，並確認強一致讀取已查無業務項目。測試執行器另清理隔離表、臨時伺服器、快取及 Chrome 設定檔。

| 項目 | 結果 |
| --- | --- |
| Workspace 生命週期 | 透過 Chrome 的同源 HTTP 請求建立、修改設定和刪除。React 顯示兩個 Workspace 各自的資料，並依各自的 `activeBoardId` 開啟看板。 |
| React 操作 | 經 UI 操作三種拖曳排序，再更新任務狀態和日期。完成時間由伺服器產生。 |
| 跨 Workspace 隔離 | 兩個 Workspace 重複使用前端 Task 與 Widget ID，但顯示與資料庫歸屬仍正確。跨 Workspace 的 Board 寫入回傳 403。 |
| 切換競態 | 延遲 A 的 Workspace View 回應並在回應前切換到 B。釋放延遲回應後仍顯示 B，可再切回 A。 |
| 重載與資料比對 | 排序及更新後兩次重新載入。比對 Workspace、Board、Task、Widget 的內容、位置、版本、父層 ID、計數、WIP、Widget Config 與 `completedAt`，未發現重複或遺失。 |
| 資料來源 | 本機新增任務未發送 API 請求。API 唯讀須明確啟用，隔離 UI 寫入另需確認 Workspace ID。API 操作期間，本機的兩個儲存鍵維持相同；讀取失敗保留 API 畫面，由 D1、D3 回歸覆蓋。 |
| 回復與錯誤 | B1 至 C4、D1 至 D3 回歸涵蓋授權、404、409、Migration Lock、WIP、逾時、Receipt 和 UNKNOWN。 |

Workspace 管理操作由測試透過瀏覽器 HTTP 請求執行。Workspace 的子資源寫入僅在隔離 grant 明確啟用且新 Workspace 由同一 grant 建立時可用，交易仍檢查原 Workspace、grant 與 Release。正式 API 寫入維持關閉。

## 執行結果

- Node、React 與 API 回歸合計 178 項通過，B1 隔離 DynamoDB 驗收通過。
- B2 至 C4 與 D1 至 D4 共 31 組整合驗收全數通過。
- Build 和 `git diff --check` 通過。
- 完整 ESLint 仍回報 `workspace-board.js` 的 3 項既有錯誤。兩處為 effect 同步更新 state，一處為首頁連結使用 `<a>`。本輪沒有新增錯誤。

重跑同一套 HTTP 與 Chrome 驗收

```powershell
node --conditions=react-server scripts/phase5b2-task-http.mjs --task-mutations --boards --widgets --workspaces --browser-write --browser-lifecycle
```

本輪保留正式 Workspace、原始備份與使用者 Chrome 儲存，沒有執行正式 Migration、Release、Cutover 或 Git 提交。
