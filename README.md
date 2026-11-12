# Slowly — 我的任務看板

使用 Next.js 與 React 製作的 Kanban 風格 Todo List。透過三欄看板整理任務，搭配優先處理泳道與完成進度，依照自己的步調管理日常工作。

目前採用純前端互動，任務透過瀏覽器的 `localStorage` 儲存，無須設定 API、資料庫或環境變數。

## 功能

- **三欄看板** — 待處理、進行中、已完成。
- **任務管理** — 新增、編輯、刪除任務，刪除前會顯示確認視窗。
- **任務內容** — 名稱、描述、分類、優先程度、截止日期與狀態。
- **分類標籤** — 個人、工作、設計、開發、生活。
- **優先程度** — 低、一般、高。
- **任務移動** — 拖曳卡片到其他欄位，或使用卡片下方的狀態選單。
- **優先處理泳道** — 將重要任務放入下方的 EXPEDITE 區域，也可拖曳卡片切換泳道。
- **WIP 上限** — 進行中最多 4 件，計算範圍包含一般與優先處理泳道。
- **搜尋與篩選** — 搜尋名稱、描述與分類，並切換全部任務、未完成或高優先。
- **進度統計** — 顯示任務總數、進行中數量與完成百分比。
- **本機儲存** — 重新整理頁面後，讀回同一瀏覽器中儲存的任務。
- **響應式版面** — 窄螢幕可橫向捲動看板。

## 開發環境

| 工具 | 專案版本或需求 |
| --- | --- |
| Node.js | 20.9.0 以上 |
| npm | 隨 Node.js 安裝 |
| Next.js | 16.4.6 |
| React / React DOM | 19.3.0 |
| Tailwind CSS | 4.3.3 |
| ESLint | 9 |

專案使用 JavaScript、App Router 與 `src/` 目錄，樣式主要寫在 `globals.css`。

## 安裝與啟動現有專案

在包含 `mytodolist` 的目錄開啟終端機，執行下列指令。若已經位於專案目錄，可略過第一行。

```bash
cd mytodolist
npm ci
npm run dev
```

啟動後，在瀏覽器開啟 `http://localhost:3000`。若 3000 埠已被占用，請使用終端機實際顯示的網址。

`npm ci` 會依照 `package-lock.json` 安裝相同版本的依賴。修改程式後，開發伺服器會自動更新頁面。

### Windows PowerShell

若執行 npm 時出現「已停用指令碼執行」錯誤，可使用 `.cmd` 指令。

```powershell
cd mytodolist
npm.cmd ci
npm.cmd run dev
```

以下的 npm、npx 指令也可分別改成 `npm.cmd`、`npx.cmd`。

## 從零建立 Next.js 專案

這段流程用於建立新的專案骨架。請在尚未存在 `mytodolist` 資料夾的位置執行。

```bash
npx create-next-app@16.4.6 mytodolist --js --eslint --tailwind --app --src-dir --import-alias "@/*" --use-npm
cd mytodolist
npm run dev
```

若出現額外設定提問，可依開發需求選擇。建立後，將本專案的 `src/app/page.js`、`src/app/layout.js`、`src/app/globals.css` 加入新專案，即可套用看板介面與功能。

要重現本專案的完整依賴與 Turbopack 樣式設定，請使用現有專案中的 `package.json`、`package-lock.json` 與 `next.config.mjs`，再執行 `npm ci`。初始化工具建立的骨架與設定可能有所差異。

## 使用方式

1. 首次開啟時會顯示範例任務，可直接編輯或刪除。
2. 點擊右上角「新增任務」，或各欄底部的「新增任務」。
3. 填寫任務名稱，視需要補上描述、分類、優先程度與截止日期。
4. 勾選「放入優先處理泳道」，即可將任務放到下方區域。
5. 點擊「儲存任務」完成新增。點擊卡片標題或右上角的「•••」可再次編輯。
6. 拖曳卡片或使用狀態選單調整進度。進行中達 4 件時，先移出或完成任務，才能加入下一件。
7. 使用搜尋框與頁籤篩選任務。上方統計仍會顯示整個看板的數量。

## 常用指令

| 指令 | 用途 |
| --- | --- |
| `npm run dev` | 啟動開發伺服器 |
| `npm run build` | 建立正式環境版本 |
| `npm run start` | 啟動已建置的正式環境版本 |
| `npm run lint` | 執行 ESLint 程式碼檢查 |

正式環境預覽需先建置，再啟動。

```bash
npm run build
npm run start
```

## 專案結構

```text
mytodolist/
├─ src/
│  └─ app/
│     ├─ page.js          # 看板介面、任務操作與 localStorage
│     ├─ layout.js        # 共用版型、頁面資訊與字型
│     ├─ globals.css      # 全域樣式、看板與響應式版面
│     └─ favicon.ico
├─ public/               # 靜態資源
├─ AGENTS.md             # AI 開發工具使用的專案規範
├─ next.config.mjs       # Next.js 與 Tailwind Turbopack 設定
├─ eslint.config.mjs     # ESLint 設定
├─ package.json          # 依賴與執行指令
└─ package-lock.json     # 依賴版本鎖定檔
```

## 注意事項

### 資料保存

- 任務儲存在目前瀏覽器、目前網站來源的 `localStorage`，使用的 key 為 `slowly-board-v1`。
- 清除網站資料、更換瀏覽器或使用其他裝置，會影響能讀取的任務紀錄。不同網域或連接埠也會使用各自的儲存空間。
- 無痕模式中的紀錄可能在關閉視窗後移除。
- 目前以單一分頁操作為主，多個分頁同時編輯時，後寫入的內容可能覆蓋先前紀錄。
- 本機紀錄沒有備份、匯出與跨裝置同步功能。Git 提交與 GitHub 推送保存的是程式碼，瀏覽器中的任務需另外保存。
- 若瀏覽器阻擋儲存或空間不足，畫面會顯示通知。此時的變更僅保留在目前開啟的頁面。

### 任務操作

- 任務名稱必填，最多 100 字元；描述最多 1,000 字元。
- 截止日期用於顯示與記錄，目前沒有到期提醒。
- 完成進度以整個看板的已完成數量除以總數計算，包含優先處理泳道中的任務。
- 卡片移動會更新狀態與泳道，目前沒有同欄卡片排序功能。
- 觸控裝置上的拖曳支援依瀏覽器而異，可使用狀態選單移動任務，並透過編輯視窗切換泳道。

### 安裝與建置

- 安裝依賴需要網路連線。`layout.js` 使用 `next/font/google` 載入 Geist 字型，首次開發或建置也可能需要連線至 Google Fonts。
- 若出現 `Failed to fetch Geist from Google Fonts`，請檢查網路連線與代理設定，再重新執行建置。
- 請保留 `package-lock.json`，讓其他開發者能透過 `npm ci` 安裝一致的依賴。
- `node_modules` 與 `.next` 已列入 `.gitignore`，由安裝與建置指令產生。
- 專案檔案使用 UTF-8 編碼，編輯中文內容時請維持相同編碼。
