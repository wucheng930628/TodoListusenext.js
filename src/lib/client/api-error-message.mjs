const messages = {
  VALIDATION: "欄位或排序資料不合法，請檢查後再送出。",
  FORBIDDEN: "目前沒有此工作空間的操作權限。",
  OWNERSHIP: "此項目不屬於目前工作空間或看板。",
  NOT_FOUND: "伺服器找不到此項目，請重新讀取。",
  CONFLICT: "版本已變更，請比對最新資料後再操作。",
  VERSION_CONFLICT: "版本已變更，請比對最新資料後再操作。",
  SNAPSHOT_NOT_READY: "資料正在同步，請稍後重新讀取。",
  OPERATION_CONFLICT: "操作識別碼與原始請求不一致，請核對操作紀錄。",
  WIP_LIMIT: "進行中任務已達 WIP 上限。",
  MIGRATION_LOCKED: "資料受遷移鎖保護，目前保持唯讀。",
  NETWORK_ERROR: "無法連線到 API，請檢查網路後重新讀取。",
};

export function apiErrorMessage(error) {
  if ((error.method !== "GET" && error.outcome === "not-confirmed") || ["OPERATION_UNKNOWN", "UNKNOWN_OPERATION"].includes(error.code)) {
    return "寫入結果尚未確認。請先查詢 Receipt，保留目前輸入，勿直接重送。";
  }
  return messages[error.code] ?? (error.status >= 500 ? "伺服器暫時無法回應，請稍後重新讀取。" : error.message);
}
