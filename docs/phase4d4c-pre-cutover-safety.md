# Phase 4D-4C 正式 Cutover 前安全驗收

2026-11-19，Asia/Taipei。正式 Cutover 維持 **NOT READY**。本輪只讀取正式資料、驗證私人 Evidence、執行隔離測試及補強操作回復防護。正式首頁仍以 localStorage 為預設來源。

## 正式備份、資料與 Readiness

| 檢查 | 結果 |
| --- | --- |
| Verified Backup | `slowly-verified-backup` v1，格式及 Payload SHA-256 通過。原始檔案前後相同 |
| Payload SHA-256 | `4c9b8fc3a2a1eafcd64f657eb7927298863dc485b08179323e9cef030f12cbc7` |
| Migration／Plan ID | `51684a8d9688456849e25c5e59a2119febecbb37fa4635e671dda8792cfdf197` |
| Workspace | `SLOWLY#WORKSPACE#cd5aa79a-3fb4-8b5c-b610-aadd79b8f49c` |
| Source Namespace | `dryrun-6edab0e2-c674-4044-91a1-dbb276e8f418` |
| 來源政策 | `slowly-workspace-v2` 為 Primary，`slowly-board-v1` 明確排除 2 筆 Legacy Tasks |
| 正式 Session／Release | 版本 35，Session 與鎖均為 `RELEASED`，10/10 Receipt `CONFIRMED`，10/10 已釋放 |
| 正式 View | 暫時的程序內設定呼叫既有正式 GET handler，正確綁定 200、其他 Workspace 403、錯誤 Plan／Namespace 409。常駐程序設定未修改 |
| Data Fidelity | **0 差異**。Workspace View Model 與備份逐欄相同，1 Workspace、2 Boards、6 Tasks、1 Widget |
| SlowlyTasks | 33 筆前後相同，原有未知 Item 雜湊與基準一致 |
| Gate | `evidenceVerified: true`、`ready: false`、`cutoverEnabled: false`、`CUTOVER_APPROVAL_REQUIRED` |

前次準備 Bundle 已於台北時間 2026-11-18 23:16:33 到期。本輪沿用既有的唯讀產生工具，在原私人目錄建立新子目錄，以新產生的伺服器金鑰簽署 `release-preparation` Bundle。HMAC-SHA256 簽章、效期、用途、Session、Manifest、Receipt、Ownership、Verify、Release 與 View 比對均通過。本輪 Bundle 到期時間為台北時間 **2026-11-19 01:25:10**。金鑰值未輸出。下一階段需以當時有效的證據重驗。準備 Bundle 的用途會阻擋正式 Cutover。

## 正式瀏覽器人工驗收

使用者真實 Chrome 狀態為 **NOT TESTED**。程式檢查確認預設為 localStorage。API 模式略過本機儲存效果，切回 localStorage 會重新讀取本機來源，沒有自動合併或回灌 API 資料。Pending Write、UNKNOWN 與草稿會阻擋切換。草稿存於頁面記憶體，強制重整或關閉頁籤仍可能失去草稿，瀏覽器離開提示也可能受其互動限制。Recovery Journal 用來保存操作資訊。

1. 在原本 Chrome 設定檔、原本網站 origin 和**仍開著的** slowly. 頁籤確認資料來源為 localStorage。先檢視所有開啟的 Task、Board、Widget 表單與其他正在編輯的頁籤。含草稿時保留頁籤，先由使用者決定如何處理。
2. 若可見開發模式資料來源控制，使用「檢視未儲存草稿」及「檢查 Reload 恢復紀錄」。預期顯示無未儲存草稿及無未確認操作。也可唯讀檢視 DevTools Application → IndexedDB 的 `slowly-api-recovery-v1-formal` → `operations`，確認無 `active` 記錄。Journal 無法讀取、存在 active，或畫面顯示寫入中／寫入結果未確認時停止。保留紀錄。
3. 確認沒有其他頁籤在編輯或送出寫入，再由使用者確認兩個來源 Key 自備份後未變並凍結來源。若無法確認，使用原 origin 的 `/dev/backup`，手動建立及下載另一份已驗證備份，保存到私人目錄並用頁面選檔驗證。每次匯出時間不同，可比對兩個來源 Key 的原始內容及其摘要。若內容不同，停在差異審查，原始備份應原樣保留。

## 切換失敗與回復

1. 若 API 啟用或刷新遇到斷線、版本異常、404／409、投影不完整或資料不同，停止新寫入，保留頁籤、草稿與 Recovery Journal。核對綁定 Workspace 和最新完整伺服器 View。刷新失敗會停用寫入，待使用者決定來源。
2. Pending Write 先等待。取消等待只中止客戶端等待，伺服器仍可能提交。遇到 UNKNOWN 新增，使用原 Workspace、Operation Key 及範圍查 Receipt。若 CONFIRMED，重讀最新伺服器資料再完成恢復。若 NOT_FOUND，結果仍不明，保留原始 Key 和 payload。任何重送均須經明確操作，並通過正式寫入權限檢查。更新、刪除或排序結果不明時，要比對伺服器實際狀態後再人工確認。
3. 無 Pending／UNKNOWN／草稿後，才由使用者明確切回 localStorage。切回時仍讀既有的本機快照。若先前已有 API 新寫入，先另行備份並比對兩個來源，避免用舊快照覆蓋新資料。重新整理會重走預設 localStorage 與 Journal 檢查，尚有 Journal 記錄時阻擋編輯，需明確選擇原 Workspace 處理恢復。

## 本輪修改

- `src/lib/client/main-workspace-controller.mjs` 在重新查詢 Receipt 後、手動重送新增之前，補上現有正式寫入授權期限檢查。唯讀 Receipt 查詢仍可先完成。
- `tests/cutover-safety.test.mjs` 加入重整後 Gate 過期的回歸案例，確認只送出 GET、保留原 Journal 與 UNKNOWN 狀態。
- 本文件記錄正式檢查、瀏覽器驗收、人工確認與安全回復步驟。

## 測試與清理

| 範圍 | 結果 |
| --- | --- |
| Node、React、API、Migration、Release、Cutover Safety、Trusted Evidence 等測試 | 225 通過、0 失敗、0 跳過。其中 6 項為隔離 DynamoDB Local Dry Run。Cutover Safety 18 項包括本輪新增的重送防護 |
| DynamoDB Local Main UI／Safe Create／Next HTTP | 20 項通過，含 409、Idempotency-Key、遺失交易回應及持久化 Receipt |
| DynamoDB Local Release | 13 項通過，含部分釋放屏障、回應遺失、並行與完整保真 |
| DynamoDB Local Trusted Evidence | 7 項通過，含過期、竄改與目標版本異動的拒絕測試 |
| Build、修改程式 ESLint、Git whitespace 檢查 | 通過。Build 另提示忽略 Git 工作樹外層的 package-lock.json |

切換及讀取錯誤、資料投影不完整、409、UNKNOWN 更新與取消等待等判定由現有 Node／React 測試覆蓋。正式資料差異由伺服器唯讀比對確認；正式 Chrome 使用者狀態仍需上方人工確認。

隔離環境以真實無頭 Chrome 157.0.8103.51、新 Chrome 設定檔、loopback origin 與獨立 DynamoDB Local 表驗收。故障注入在伺服器提交後模擬回應遺失及 Receipt 暫時無法查詢，再由 Chrome 實際重整。最終 run `e9eac211-321b-4f8e-9537-f616d65d2bdf` 為 **8 PASS／0 FAIL／0 NOT TESTED**。

| 真實隔離 Chrome 驗收 | 結果 |
| --- | --- |
| IndexedDB 保存 Pending Operation | PASS |
| Pending 時阻擋 Workspace 與資料來源切換 | PASS |
| 實際重新整理並恢復 UNKNOWN | PASS |
| CONFIRMED 後重讀最新伺服器資料 | PASS |
| 實際 HTTP 409 顯示衝突並保留草稿 | PASS |
| Task、Board、Widget 草稿保護 | PASS |
| API 與 localStorage 模式隔離 | PASS |
| Legacy v1 維持原樣且不自動匯入 | PASS |

首次 Chrome 嘗試在草稿確認後逾時。將驗收驅動的確認訊息改為不受 PowerShell 標準輸入編碼影響的 Unicode 比對，再以新 profile 與新表重跑後通過。兩輪的測試表、伺服器及 Chrome 暫存設定檔均已清理，正式表快照一致。未擷取 Browser Trace 或 Screenshot。

## Phase 4D-4D 授權邊界

可進入下一階段的準備與審核。正式切換仍須先完成人工瀏覽器檢查與來源凍結，核對備份與 Recovery Journal，並對指定 Workspace／Plan 取得使用者明確的正式 Cutover 授權。之後由伺服器重驗時效內的完整簽章證據，其中需包含經審核的瀏覽器驗收、驗證報告、同一 Plan 的隔離 Dry Run、來源凍結與授權。Gate 必須當下同時回傳 `ready: true` 與 `cutoverEnabled: true` 才能進入正式切換操作。
