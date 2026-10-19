import { serializeSwapPreview, deserializeSwapPreview, hasValidDleq } from '@cashu/cashu-ts'
import { contentHash } from './protocol.js'
import { requireBackup, plainSwap } from './escrow.js'

const amount=p=>Number(p.amount)
function feeLock(lock,agreement,id) {
  if(lock.data!==`02${agreement.feeRecipient}`||!Array.isArray(lock.tags)||lock.tags.length<1||lock.tags.length>2)return false
  const tags=new Map(lock.tags.map(t=>[t[0],t.slice(1)]))
  return tags.size===lock.tags.length&&[...tags.keys()].every(k=>['sigflag','wot-agreement'].includes(k))&&(!tags.has('sigflag')||JSON.stringify(tags.get('sigflag'))==='["SIG_INPUTS"]')&&JSON.stringify(tags.get('wot-agreement'))===JSON.stringify([id])
}
export async function verifyFeeProofs(wallet,agreement,proofs) {
  const id=await contentHash(agreement)
  if(!proofs?.length||proofs.reduce((sum,p)=>sum+BigInt(amount(p)),0n)!==BigInt(agreement.serviceFeeSats)||new Set(proofs.map(p=>p.secret)).size!==proofs.length)throw new Error('Fee proof amount mismatch.')
  for(const p of proofs) {
    const [kind,lock]=JSON.parse(p.secret)
    if(kind!=='P2PK'||!feeLock(lock,agreement,id)||!hasValidDleq(p,wallet.getKeyset(p.id),{require:true}))throw new Error('Service fee is not locked to the agreed recipient and agreement.')
  }
  return true
}
export async function prepareFee(wallet,agreement,proofs) {
  const preview=await wallet.prepareSwapToSend(agreement.serviceFeeSats,proofs,{requireDleq:true},{send:{type:'p2pk',options:{pubkey:`02${agreement.feeRecipient}`,sigFlag:'SIG_INPUTS',additionalTags:[['wot-agreement',await contentHash(agreement)]]}}})
  if(Number(preview.fees)>agreement.fundingFeeSats)throw new Error('Fee transfer cost exceeds the agreed funding allowance.')
  return {kind:'service-fee',agreementId:await contentHash(agreement),revision:crypto.randomUUID(),preview:serializeSwapPreview(preview)}
}
export async function completeFee(wallet,agreement,operation,backup) {
  if(operation.kind!=='service-fee'||operation.agreementId!==await contentHash(agreement))throw new Error('Wrong fee operation.')
  const preview=deserializeSwapPreview(operation.preview)
  const outputs=preview.sendOutputs||[]
  if(outputs.reduce((n,o)=>n+Number(o.blindedMessage.amount),0)!==agreement.serviceFeeSats||outputs.some(o=>{const [kind,lock]=JSON.parse(new TextDecoder().decode(o.secret));return kind!=='P2PK'||!feeLock(lock,agreement,operation.agreementId)}))throw new Error('Fee outputs have changed.')
  if(Number(preview.fees)>agreement.fundingFeeSats)throw new Error('Fee transfer cost exceeds the agreed funding allowance.')
  await requireBackup(operation,backup)
  const result=plainSwap(await wallet.completeSwap(preview))
  await verifyFeeProofs(wallet,agreement,result.send)
  return result
}
