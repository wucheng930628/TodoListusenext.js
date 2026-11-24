# Phase 5-E 遷移並行完整性調查

在同一隔離表，以 `--force-parent-overlap` 控制兩個同父層的遷移操作，修正前在 `parentChanges → ownedTarget` 重現 `INTEGRITY_CONFLICT`。

1. 請求 A 讀取父 Board 版本 1、父 Receipt 版本 2（`managedVersion = 1`），接著暫停。
2. 請求 B 原子提交子項和 Receipt，將父 Board 升為版本 2、父 Receipt 升為版本 3（`managedVersion = 2`），Session 升為版本 13。Session 維持 `RUNNING`，Lock 為 `HELD`，已 Release 項目為 0。
3. A 恢復執行，用另一個強一致讀取取得父 Board 版本 2，卻仍使用先前的 Receipt 驗證。版本與雜湊取自兩個交易快照，A 在業務交易提交前誤報完整性衝突。

B 的父項、Receipt 與 Session 提交保持一致。此重現沒有 Release、鎖殘留、重複子項或跨測試表寫入。

## 修正

以 `TransactGet` 同時取得父項與父 Receipt，使用同一份父項驗證 ownership、鎖、版本、雜湊與父層計數。Manifest 與來源綁定照常驗證。父項、父 Receipt、子項、子 Receipt 與 Session 仍用既有條件式交易提交。若快照在提交前落後，既有版本衝突處理仍適用。沒有新增重試或忽略完整性錯誤。

既有的外部竄改父版本案例仍須回傳 `INTEGRITY_CONFLICT`，且不得建立子項。只在原先允許隔離遷移的工具加入交易讀取支援，測試表限制仍適用。

## 重現與追蹤

```powershell
npm.cmd run test:db:migration -- --isolated-table
npm.cmd run test:db:migration -- --isolated-table --force-parent-overlap
```

執行器使用獨立測試表，並列出 `.phase4b1-test-runs/` 下的報告路徑。報告保存請求 ID、Operation ID、DynamoDB Request ID、時間、讀取與寫入版本、鎖與 Release 狀態、條件式失敗及錯誤堆疊。修正前的重現報告為 `ac25fe10-5b68-4f8d-8c54-66c00ef939cb.json`。正式表只用於測試前後的唯讀對照。

## 修正後回歸

- 原始自然並行 10/10 輪，受控交錯 10/10 輪。每輪 14 個案例，合計 280/280。所有隔離表均清理。
- 全部 Node 測試檔合計 238/238。Phase 4 隔離 Controlled UI 6/6、Release 13/13、Main UI／Safe Create 19/19、Trusted Evidence 8/8。
- Phase 5 B1 隔離套件通過，HTTP 與 Chrome 回歸 31/31 組，涵蓋 B2 至 C4、D1 至 D4 及 Next.js 重啟。
- Build、修改檔案 ESLint、git diff --check 通過。完整 ESLint 仍有 workspace-board.js 三項既有錯誤，本輪沒有新增。
