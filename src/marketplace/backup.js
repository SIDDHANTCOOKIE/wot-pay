import { encryptBackup, digest, replicateBackup, recoveryServers, recoverRemote } from '../recovery.js'
import { verifyEvent } from 'nostr-tools/pure'
import { contentHash } from './protocol.js'

// Called before every consuming mint request. A receipt is tied to the exact
// operation revision and a full encrypted snapshot that includes its secrets.
export async function backupOperation(vault, signer, operation, fetcher = fetch, client) {
  const config = await vault.read('recovery-config')
  if (!config?.value.savedOffline) throw new Error('Configure automatic recovery and save the recovery kit before funding.')
  const servers = recoveryServers(config.value.servers)
  const operationHash = await contentHash(operation)
  const records=(await vault.snapshot()).filter(row=>row.id!=='backup-index')
  const snapshot = { version: 2, owner: signer.pubkey, createdAt: Date.now(), records, operation }
  const bytes = await encryptBackup(snapshot, config.value.secret)
  const result = await replicateBackup({ bytes, servers, signer, fetcher })
  const row = await vault.read('backup-index')
  await vault.write('backup-index', { hash: await digest(bytes), servers, operationHash, snapshotHash:await contentHash(records), encryptedBackup:new TextDecoder().decode(bytes), checkedAt: result.checkedAt, results: result.results }, row?.revision || 0)
  if (result.verifiedCopies < 2) throw new Error('Fewer than two backup copies verified. Funds have not been moved by this operation.')
  if(!client)throw new Error('Recovery discovery relays are required before moving funds.')
  const pointer=await signer.sign({kind:1,created_at:Math.floor(Date.now()/1000),tags:[['t','wot-pay-recovery-v2']],content:await signer.sealLocal({owner:signer.pubkey,hash:result.hash,servers,createdAt:Date.now()})})
  // Append-only pointers avoid same-second replacement races. Read back the
  // signed ID from two distinct relay hosts before acknowledging the backup.
  const hosts=new Set(),verified=[]
  for(const url of client.relays) {
    const host=new URL(url).hostname
    if(hosts.has(host))continue
    hosts.add(host)
    try {await client.publishTo([url],pointer);const events=await client.queryOn([url],{ids:[pointer.id]});if(events.some(e=>e.id===pointer.id&&verifyEvent(JSON.parse(JSON.stringify(e)))))verified.push(url)}catch{}
  }
  if(verified.length<2)throw new Error('Backup bytes are safe, but two recovery index relays have not verified the pointer. No funds moved.')
  const latest=await vault.read('backup-index')
  if(latest.value.hash===result.hash)await vault.write(latest.id,{...latest.value,pointerVerified:true},latest.revision)
  return { operationHash, ...result }
}

export async function syncPrivateBackup(vault,signer,fetcher=fetch,client) {
  const config=await vault.read('recovery-config')
  if(!config?.value.savedOffline)return null
  const records=(await vault.snapshot()).filter(row=>row.id!=='backup-index')
  const hash=await contentHash(records),index=await vault.read('backup-index')
  if(index?.value.snapshotHash===hash&&index.value.encryptedBackup&&index.value.pointerVerified) {
    const result=await replicateBackup({bytes:new TextEncoder().encode(index.value.encryptedBackup),servers:config.value.servers,signer,fetcher})
    await vault.write('backup-index',{...index.value,checkedAt:result.checkedAt,results:result.results},index.revision)
    return result
  }
  return backupOperation(vault,signer,{kind:'automatic-snapshot',revision:hash},fetcher,client)
}

export async function findRemoteSnapshots(client,signer,secret,fetcher=fetch) {
  const events=await client.queryIdentity({kinds:[1],authors:[signer.pubkey],'#t':['wot-pay-recovery-v2']})
  const pointers=[]
  for(const event of events)try {
    if(event.pubkey!==signer.pubkey||!verifyEvent(JSON.parse(JSON.stringify(event))))continue
    const pointer=await signer.openLocal(event.content)
    if(pointer.owner===signer.pubkey&&Number.isSafeInteger(pointer.createdAt)&&pointer.createdAt<=Date.now()+60000)pointers.push(pointer)
  }catch{}
  // An older backup may omit an already-issued signature. Never silently
  // roll back the signing journal just because the newest blob is unavailable.
  const newestTime=Math.max(...pointers.map(p=>p.createdAt))
  for(const pointer of pointers.filter(p=>p.createdAt===newestTime))try {
    const snapshot=await recoverRemote({...pointer,secret,fetcher})
    if(snapshot.version===2&&snapshot.owner===signer.pubkey&&Array.isArray(snapshot.records))return snapshot
  }catch{}
  throw new Error('The newest recovery snapshot is unavailable or invalid. Restore access to its replicas before signing or funding; an older kit may omit operations already sent.')
}
