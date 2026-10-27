import { useState } from 'react';
import { siteOrigin, hostPermission } from '../archive/binding';
import { archiveCommand, useArchiveStatus } from '../archive/ui';
export function SiteConnection() {
  const { status, error: readError } = useArchiveStatus();
  const [origin, setOrigin] = useState(''); const [code, setCode] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  function connect() {
    setError('');
    try {
      const normalized = siteOrigin(origin.trim()); if (!code.trim()) throw new Error('请填写站点设置中生成的一次性配对码。');
      // Must stay synchronous with the explicit button gesture; no startup prompts.
      const permission = chrome.permissions.request({ origins: [hostPermission(normalized)] }); setBusy(true);
      void permission.then(async allowed => {
        if (!allowed) throw new Error('未授权站点访问，连接尚未建立。');
        await archiveCommand({ type: 'archive:pair', origin: normalized, code: code.trim() }); setCode('');
      }).catch(e => setError(e instanceof Error ? e.message : '连接失败。')).finally(() => setBusy(false));
    } catch (e) { setError(e instanceof Error ? e.message : '地址无效。'); }
  }
  return <section className="card archive-connection" aria-label="资料站点连接">
    <h2>资料站点</h2>
    <p className="hint">保存原文到你自己的资料库。配对码在站点设置中生成，5 分钟内有效。保存中文资料无需 API Key。</p>
    {status.binding && <p role="status"><strong>已连接 · {status.username}</strong><br /><span className="archive-origin">{status.binding.siteOrigin}</span></p>}
    <label className="field">站点地址<input type="url" placeholder="https://library.example.com" value={origin} onChange={e => setOrigin(e.target.value)} disabled={busy} /></label>
    <label className="field">一次性配对码<input type="password" autoComplete="off" value={code} onChange={e => setCode(e.target.value)} disabled={busy} /></label>
    <div className="actions row"><button className="primary" type="button" onClick={connect} disabled={busy}>{busy ? '正在连接…' : '授权并连接站点'}</button>
      {status.binding && <button type="button" disabled={busy} onClick={() => { void archiveCommand({ type: 'archive:disconnect' }).catch(e => setError(String(e))); }}>断开站点</button>}</div>
    <p className="hint">重新连接同一账号可接续待上传资料。断开连接保留本地归档；设备也可在站点中撤销。</p>
    {(error || readError) && <p role="alert" className="error">{error || readError}</p>}
  </section>;
}
