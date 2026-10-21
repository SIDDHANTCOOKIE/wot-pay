import { encryptBackup, digest, replicateBackup, recoveryServers, recoverRemote } from '../recovery.js'
import { verifyEvent } from 'nostr-tools/pure'
import { contentHash, parsePrivate } from './protocol.js'

// Encrypted recovery pointers use a dedicated kind so they never render as
// notes in followers' feeds.
export const RECOVERY_KIND = 3407
const RECOVERY_TAG = 'wot-pay-recovery-v3'
const isIndex = id => id === 'backup-index'

// A trade operation backs up only what that trade needs (its record, keys,
// proofs and pending messages), so the copy made inside a funding window stays
// small however many trades the device holds. Other backups are full.
export async function scopedRecords(vault, scope) {
  const records = (await vault.snapshot()).filter(row => !isIndex(row.id))
  if (!scope) return records
  return records.filter(row => row.id === `trade:${scope}` || row.id.startsWith('outbox:') && parsePrivate(row.value.signed)?.agreementId === scope)
}

// Called before every consuming mint request and payout signature. A receipt
// is tied to the exact operation revision and an encrypted snapshot of its scope.
export async function backupOperation(vault, signer, operation, fetcher = fetch, client) {
  const config = await vault.read('recovery-config')
  if (!config?.value.savedOffline) throw new Error('Configure automatic recovery and save the recovery kit before funding.')
  const servers = recoveryServers(config.value.servers)
  const operationHash = await contentHash(operation)
  const scope = /^[0-9a-f]{64}$/.test(operation.agreementId || '') ? operation.agreementId : null
  const records = await scopedRecords(vault, scope)
  const snapshot = { version: 2, owner: signer.pubkey, createdAt: Date.now(), scope, records, operation }
  const bytes = await encryptBackup(snapshot, config.value.secret)
  const result = await replicateBackup({ bytes, servers, signer, fetcher })
  // Only full snapshots are reused by background repair.
  if (!scope) {
    const row = await vault.read('backup-index')
    await vault.write('backup-index', { hash: await digest(bytes), servers, operationHash, snapshotHash: await contentHash(records), encryptedBackup: new TextDecoder().decode(bytes), checkedAt: result.checkedAt, results: result.results }, row?.revision || 0)
  }
  if (result.verifiedCopies < 2) throw new Error('Fewer than two backup copies verified. Funds have not been moved by this operation.')
  if (!client) throw new Error('Recovery discovery relays are required before moving funds.')
  const pointer = await signer.sign({ kind: RECOVERY_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['t', RECOVERY_TAG]], content: await signer.sealLocal({ owner: signer.pubkey, hash: result.hash, servers, scope, createdAt: Date.now() }) })
  // Append-only pointers avoid same-second replacement races. Read back the
  // signed ID from two distinct relay hosts before acknowledging the backup.
  const hosts = new Set(), verified = []
  for (const url of client.relays) {
    const host = new URL(url).hostname
    if (hosts.has(host)) continue
    hosts.add(host)
    try { await client.publishTo([url], pointer); const events = await client.queryOn([url], { ids: [pointer.id] }); if (events.some(e => e.id === pointer.id && verifyEvent(JSON.parse(JSON.stringify(e))))) verified.push(url) } catch {}
  }
  if (verified.length < 2) throw new Error('Backup bytes are safe, but two recovery index relays have not verified the pointer. No funds moved.')
  if (!scope) {
    const latest = await vault.read('backup-index')
    if (latest.value.hash === result.hash) await vault.write(latest.id, { ...latest.value, pointerVerified: true }, latest.revision)
  }
  return { operationHash, ...result }
}

export async function syncPrivateBackup(vault, signer, fetcher = fetch, client) {
  const config = await vault.read('recovery-config')
  if (!config?.value.savedOffline) return null
  const records = await scopedRecords(vault, null)
  const hash = await contentHash(records), index = await vault.read('backup-index')
  if (index?.value.snapshotHash === hash && index.value.encryptedBackup && index.value.pointerVerified) {
    const result = await replicateBackup({ bytes: new TextEncoder().encode(index.value.encryptedBackup), servers: config.value.servers, signer, fetcher })
    await vault.write('backup-index', { ...index.value, checkedAt: result.checkedAt, results: result.results }, index.revision)
    return result
  }
  return backupOperation(vault, signer, { kind: 'automatic-snapshot', revision: hash }, fetcher, client)
}

// Restores the newest full snapshot, then overlays every trade whose own
// backup is newer, keeping the higher revision of each record. The newest
// copy of every scope must be readable: an older copy may omit a signature
// already sent, so recovery never silently rolls back.
export async function findRemoteSnapshots(client, signer, secret, fetcher = fetch) {
  const events = await client.queryIdentity({ kinds: [RECOVERY_KIND], authors: [signer.pubkey], '#t': [RECOVERY_TAG] })
  const pointers = []
  for (const event of events) try {
    if (event.kind !== RECOVERY_KIND || event.pubkey !== signer.pubkey || !verifyEvent(JSON.parse(JSON.stringify(event)))) continue
    const pointer = await signer.openLocal(event.content)
    if (pointer.owner === signer.pubkey && Number.isSafeInteger(pointer.createdAt) && pointer.createdAt <= Date.now() + 60000 && (pointer.scope == null || /^[0-9a-f]{64}$/.test(pointer.scope))) pointers.push(pointer)
  } catch {}
  if (!pointers.length) throw new Error('No recovery snapshot was found for this identity.')
  const newest = list => list.filter(p => p.createdAt === Math.max(...list.map(q => q.createdAt)))
  async function load(candidates) {
    for (const pointer of candidates) try {
      const snapshot = await recoverRemote({ ...pointer, secret, fetcher })
      if (snapshot.version === 2 && snapshot.owner === signer.pubkey && Array.isArray(snapshot.records) && (snapshot.scope ?? null) === (pointer.scope ?? null)) return snapshot
    } catch {}
    throw new Error('The newest recovery snapshot is unavailable or invalid. Restore access to its replicas before signing or funding; an older kit may omit operations already sent.')
  }
  const full = pointers.filter(p => !p.scope), since = full.length ? Math.max(...full.map(p => p.createdAt)) : -Infinity
  const loaded = full.length ? [await load(newest(full))] : []
  for (const scope of new Set(pointers.filter(p => p.scope && p.createdAt > since).map(p => p.scope)))
    loaded.push(await load(newest(pointers.filter(p => p.scope === scope))))
  const records = new Map()
  for (const snapshot of loaded) for (const row of snapshot.records)
    if (!records.has(row.id) || row.revision > records.get(row.id).revision) records.set(row.id, row)
  const latest = loaded.reduce((a, b) => b.createdAt > a.createdAt ? b : a)
  return { version: 2, owner: signer.pubkey, createdAt: latest.createdAt, records: [...records.values()], operation: latest.operation }
}
