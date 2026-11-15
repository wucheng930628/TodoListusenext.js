"use client";
import { useState } from "react";
import { captureVerifiedBackup, downloadBackupArtifact, verifyBackupArtifact } from "../lib/client/verified-backup.mjs";

export default function WorkspaceBackupTool({ capture = captureVerifiedBackup, download = downloadBackupArtifact }) {
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  async function exportBackup() {
    if (!consent || busy) return;
    setBusy(true); setError(""); setResult(null);
    try {
      const artifact = await capture({ origin: window.location.origin });
      const verified = await verifyBackupArtifact(artifact);
      download(artifact);
      setResult({ ...verified, action: "download" });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "備份失敗。"); }
    finally { setBusy(false); }
  }
  async function verifyFile(event) {
    const file = event.target.files?.[0];
    if (!file || busy) return;
    setBusy(true); setError(""); setResult(null);
    try { setResult({ ...await verifyBackupArtifact(await file.text()), action: "verify" }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "驗證失敗。"); }
    finally { setBusy(false); event.target.value = ""; }
  }
  return <main style={{ maxWidth: 760, margin: "48px auto", padding: 24 }}>
    <h1>本機資料備份</h1>
    <p>請使用原本存有任務的網址與瀏覽器個人資料。下載後，自行將備份保存在專案以外的安全位置。</p>
    <label><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />我確認讀取此網址的 slowly. 本機資料並下載備份</label>
    <p><button type="button" disabled={!consent || busy} onClick={exportBackup}>{busy ? "處理中…" : "建立並下載已驗證備份"}</button></p>
    <label>驗證已下載的備份檔<input type="file" accept="application/json,.json" disabled={busy} onChange={verifyFile} /></label>
    {error && <p role="alert">{error}</p>}
    {result && <section role="status">
      <p>{result.action === "download" ? "已交由瀏覽器下載，請確認檔案已保存在安全位置。" : "檔案 Fingerprint 與原始 JSON 往返驗證通過。"}</p>
      <p>SHA-256（備份 Payload）<code style={{ overflowWrap: "anywhere" }}>{result.fingerprint}</code></p>
      <p>來源 {result.sourceInfo.origin} · 建立時間 {result.backup.createdAt}</p>
      <ul>{result.backup.sources.map(source => <li key={source.key}>{source.key} · Storage v{source.storageVersion} · {source.summary.boards} 看板／{source.summary.tasks} 任務／{source.summary.widgets} 小組件</li>)}</ul>
      <p>備份通過完整性驗證後，仍需以 Migration Preview 檢查資料相容性。</p>
    </section>}
  </main>;
}
