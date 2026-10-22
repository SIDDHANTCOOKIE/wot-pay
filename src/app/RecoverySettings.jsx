import { useState } from 'react'
import { getPublicKey } from 'nostr-tools/pure'
import { decode } from 'nostr-tools/nip19'
import { createHistory, verifiedPublicEvent } from '../history.js'
import { makeRecoveryKit, openRecoveryKit, recoveryServers, replicateBackup, newRecoverySecret, SUGGESTED_SERVERS } from '../recovery.js'
import { createVault } from '../marketplace/vault.js'
import { findRemoteSnapshots } from '../marketplace/backup.js'
import { exportLocalKey, importLocalKey, localSigner, saveSignerChoice } from './identity.js'

function download(kit) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(kit)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url; a.download = `wot-pay-recovery-${kit.createdAt}.json`; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export default function RecoverySettings({ signer, onSigner, market }) {
  const [servers, setServers] = useState(SUGGESTED_SERVERS)
  const [kit, setKit] = useState(null)
  const [restore, setRestore] = useState(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [automaticReady,setAutomaticReady]=useState(false)
  async function run(work) {
    setBusy(true); setStatus('')
    try { await work() } catch (e) { setStatus(e.message) } finally { setBusy(false) }
  }
  async function snapshot() {
    const history = createHistory()
    const data = { version: 1, owner: signer.pubkey, createdAt: Date.now(), deviceKey: signer.kind === 'local' ? exportLocalKey() : null, vaultKey: signer.kind !== 'local' && signer.vaultKey ? await signer.vaultKey() : null, events: await history.load(), pending: await history.pending(signer.pubkey), privateRecords:market?.vault?await market.vault.snapshot():[] }
    const configured = servers.some(Boolean) ? recoveryServers(servers) : []
    const next = await makeRecoveryKit(data, configured)
    setKit(next); download(next)
    setStatus('Kit created. Keep the downloaded file somewhere safe before uploading encrypted replicas.')
  }
  async function replicate() {
    const result = await replicateBackup({ bytes: new TextEncoder().encode(kit.encryptedBackup), servers: recoveryServers(servers), signer })
    const next = { ...kit, servers: recoveryServers(servers), replication: result }
    setKit(next); download(next)
    setStatus(`${result.verifiedCopies}/3 copies verified now. ${result.verifiedCopies >= 2 ? 'The two-copy backup threshold is met for this snapshot.' : 'Backup threshold not met.'} Downloaded an updated kit with server locations. ${result.results.filter(r => !r.verified).map(r => `${r.server}: ${r.error}`).join(' ')}`)
  }
  async function inspect(file) {
    if (!file || file.size > 30_000_000) throw new Error('Choose a recovery kit smaller than 30 MB.')
    const data = await openRecoveryKit(JSON.parse(await file.text()))
    if (data.version !== 1 || !/^[0-9a-f]{64}$/.test(data.owner) || !Array.isArray(data.events) || !Array.isArray(data.pending)) throw new Error('Unsupported recovery contents.')
    if (data.deviceKey) {
      const decoded = decode(data.deviceKey)
      if (decoded.type !== 'nsec' || getPublicKey(decoded.data) !== data.owner) throw new Error('Backup identity does not match its key.')
    } else if (data.owner !== signer.pubkey) throw new Error('Connect the external signer for this backup first.')
    if ([...data.events, ...data.pending].some(e => !verifiedPublicEvent(e)) || data.pending.some(e => e.pubkey !== data.owner)) throw new Error('Backup contains invalid signed history.')
    if(data.vaultKey!=null&&!/^[0-9a-f]{64}$/.test(data.vaultKey))throw new Error('Invalid private trade key in backup.')
    if(data.privateRecords&&(!Array.isArray(data.privateRecords)||data.privateRecords.length>10000||data.privateRecords.some(row=>row.owner!==data.owner||typeof row.id!=='string'||!row.value)))throw new Error('Invalid private backup records.')
    setRestore(data)
  }
  async function applyRestore() {
    const history = createHistory()
    for (const event of restore.events) await history.save(event)
    for (const event of restore.pending) await history.save(event, true)
    let restoredSigner=signer
    if (restore.deviceKey) { importLocalKey(restore.deviceKey); saveSignerChoice('local'); restoredSigner=localSigner() }
    // External signers: reopen records this browser sealed before its key was lost.
    if(restore.vaultKey&&restoredSigner.importVaultKey)await restoredSigner.importVaultKey(restore.vaultKey)
    if(restore.privateRecords?.length) {
      const vault=createVault(restoredSigner)
      for(const row of restore.privateRecords) {
        if(row.owner!==restoredSigner.pubkey||typeof row.id!=='string'||!row.value)throw new Error('Invalid private backup record.')
        // Existing records may include more recent signatures; never roll them back.
        if(!await vault.read(row.id))await vault.write(row.id,row.value,0,row.revision)
      }
    }
    if(restore.deviceKey)onSigner(restoredSigner)
    setRestore(null); setStatus('Restored. Reload the app to load the recovered trade history.')
  }
  async function configureAutomatic() {
    const origins=recoveryServers(servers),old=await market.vault.read('recovery-config')
    await market.vault.write('recovery-config',{servers:origins,secret:old?.value.secret||newRecoverySecret(),savedOffline:false},old?.revision||0)
    await snapshot();setAutomaticReady(true)
    setStatus('Download the recovery kit, then confirm you saved it outside this browser to enable automatic encrypted snapshots.')
  }
  async function confirmOffline() {
    const row=await market.vault.read('recovery-config')
    await market.vault.write(row.id,{...row.value,savedOffline:true},row.revision)
    setAutomaticReady(false);setStatus('Automatic private-trade snapshots and repair enabled while this app is open. Every mint operation still requires two verified copies of its exact revision.')
  }
  async function recoverLatest() {
    const config=await market.vault.read('recovery-config')
    if(!config)throw new Error('Restore your downloaded recovery kit first.')
    const snapshot=await findRemoteSnapshots(market.client,signer,config.value.secret)
    if(snapshot.records.some(row=>row.owner!==signer.pubkey||typeof row.id!=='string'||!row.value))throw new Error('Invalid remote private records.')
    // Never overwrite newer local operations. Restoring an older kit can safely
    // advance a record only when the snapshot carries its higher source revision.
    for(const row of snapshot.records) {
      const existing=await market.vault.read(row.id)
      if(!existing)await market.vault.write(row.id,row.value,0,row.revision)
      else if(row.revision>existing.revision)await market.vault.write(row.id,row.value,existing.revision,row.revision)
    }
    await market.reload();setStatus('Recovered the latest available remote snapshot. Reconcile saved operations before creating any new payments.')
  }
  return <details className="identity-options"><summary>Recovery and encrypted backups</summary>
    <p>This snapshot includes public history, pending signed events and the device identity, plus private agreements, escrow keys, proofs and prepared operations saved by the marketplace. External signer keys must be backed up in that signer. Legacy token DMs are not included.</p>
    <p>The downloaded kit contains the recovery secret: anyone holding it can restore your device identity. Only encrypted backup bytes are sent to servers. Keep each updated kit securely.</p>
    {servers.map((server, i) => <label className="field" key={i}>Blossom server {i + 1}<input type="url" value={server} placeholder="https://your-blossom-server.example" onChange={e => setServers(prev => prev.map((value, n) => n === i ? e.target.value : value))} /></label>)}
    <p className="dim">Three suggested hosts from different operators are filled in. Saving uploads your encrypted backup and reads it back from each, which is the real test; replace any that fail or that you do not trust. Retention depends on each host.</p>
    <button className="btn primary" disabled={busy} onClick={() => run(snapshot)}>Download a new recovery kit</button>
    {market?.vault&&<button className="btn ghost" disabled={busy||servers.some(s=>!s)} onClick={()=>run(configureAutomatic)}>Set up automatic private-trade backups</button>}
    {automaticReady&&<button className="btn primary" disabled={busy} onClick={()=>run(confirmOffline)}>I saved the kit outside this browser</button>}
    {kit && <><button className="btn ghost" disabled={busy} onClick={() => download(kit)}>Download this kit again</button><button className="btn ghost" disabled={busy || servers.some(s => !s)} onClick={() => run(replicate)}>Verify / repair this snapshot on three servers</button><p className="dim">This is a point-in-time snapshot. Create a new kit after changes. Repair runs here while the app is open; there is no background service.</p></>}
    <label className="field">Restore a downloaded kit<input type="file" accept="application/json,.json" disabled={busy} onChange={e => { setRestore(null); run(() => inspect(e.target.files?.[0])) }} /></label>
    {market?.vault&&<button className="btn ghost" disabled={busy} onClick={()=>run(recoverLatest)}>Find latest encrypted backup after restoring kit</button>}
    {restore && <div className="card"><p>Restore {restore.events.length} saved events for <span className="mono">{restore.owner}</span>? {restore.deviceKey ? 'This replaces the device identity on this browser.' : 'Your external signer stays in control.'}</p><button className="btn primary" disabled={busy} onClick={() => run(applyRestore)}>Confirm restoration</button><button className="btn ghost" onClick={() => setRestore(null)}>Cancel</button></div>}
    {status && <p role="status" className="hint">{status}</p>}
  </details>
}
