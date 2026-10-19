import { Wallet, OutputData, SigAll, serializeSwapPreview, deserializeSwapPreview, getPubKeyFromPrivKey, createRandomSecretKey, hasValidDleq, meetsSignerThreshold } from '@cashu/cashu-ts'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import { canonical, contentHash, validateAgreement } from './protocol.js'

const amount = n => typeof n?.toNumber === 'function' ? n.toNumber() : Number(n)
const total = proofs => proofs.reduce((n,p) => n + BigInt(amount(p.amount)), 0n)
export const plainSwap = result => Object.fromEntries(['keep','send'].map(role=>[role,(result[role]||[]).map(p=>({...p,amount:amount(p.amount)}))]))
export function createEscrowKey() {
  const secret = createRandomSecretKey()
  return { secret: bytesToHex(secret), pubkey: bytesToHex(getPubKeyFromPrivKey(secret)) }
}
const escrowKeys = agreement => ['requester','payer','arbitrator'].map(role=>agreement.escrowKeys[role])
export const escrowLock = agreement => ({ pubkey: escrowKeys(validateAgreement(agreement)), requiredSignatures: 2, sigFlag: 'SIG_ALL' })

export function validateLockedProofs(agreement, proofs) {
  validateAgreement(agreement)
  if (!Array.isArray(proofs) || !proofs.length || proofs.length > 512 || new Set(proofs.map(p => p.secret)).size !== proofs.length || total(proofs) !== BigInt(agreement.escrowSats)) throw new Error('Escrow amount or proof set does not match.')
  const expected = escrowKeys(agreement)
  let policy
  for (const p of proofs) {
    if (!Number.isSafeInteger(amount(p.amount)) || amount(p.amount) <= 0) throw new Error('Invalid proof amount.')
    const [kind, secret] = JSON.parse(p.secret)
    if (kind !== 'P2PK' || !Array.isArray(secret.tags) || secret.tags.length !== 3) throw new Error('Escrow must use a permanent 2-of-3 lock.')
    const tags = new Map(secret.tags.map(t => [t[0], t.slice(1)]))
    if (tags.size !== 3 || canonical(tags.get('sigflag')) !== '["SIG_ALL"]' || canonical(tags.get('n_sigs')) !== '["2"]' || canonical([secret.data, ...(tags.get('pubkeys') || [])]) !== canonical(expected)) throw new Error('Wrong escrow keys, signature threshold or output binding.')
    const next = canonical({ data: secret.data, tags: secret.tags })
    if (policy && policy !== next) throw new Error('Mixed spending conditions.')
    policy = next
  }
  return proofs
}

export async function connectMint(agreement, wallet = new Wallet(agreement.mint)) {
  validateAgreement(agreement)
  await wallet.loadMint()
  for (const nut of [7, 11, 12, 19]) if (!wallet.getMintInfo().isSupported(nut).supported) throw new Error(`Mint must support NUT-${nut} for recoverable escrow.`)
  if (wallet.unit !== 'sat') throw new Error('Mint wallet must use sats.')
  return wallet
}

export async function verifyFunding(wallet, agreement, proofs) {
  validateLockedProofs(agreement, proofs)
  for (const proof of proofs) if (!hasValidDleq(proof, wallet.getKeyset(proof.id), { require: true })) throw new Error('Escrow proof lacks valid mint cryptographic evidence.')
  const states = await wallet.checkProofsStates(proofs)
  if (states.length !== proofs.length || states.some(p => p.state !== 'UNSPENT')) throw new Error('Escrow is spent, pending or unavailable.')
  return { agreementId: await contentHash(agreement), verified: true, verifiedAt: Math.floor(Date.now() / 1000), proofHash: await contentHash(proofs.map(p => ({ secret: p.secret, C: p.C, id: p.id, amount: amount(p.amount) }))) }
}

// The full prepared transaction, including output blinding data and change,
// is persisted and replicated before any mint operation can consume inputs.
export async function prepareFunding(wallet, agreement, inputProofs) {
  const preview = await wallet.prepareSwapToSend(agreement.escrowSats, inputProofs, { requireDleq: true }, { send: { type: 'p2pk', options: escrowLock(agreement) } })
  if (amount(preview.fees) > agreement.fundingFeeSats) throw new Error('Funding fee exceeds the accepted allowance. Obtain a new agreement.')
  return { agreementId: await contentHash(agreement), kind: 'funding', revision: crypto.randomUUID(), preview: serializeSwapPreview(preview) }
}
export async function completeFunding(wallet, agreement, operation, durableBackup) {
  if (operation.agreementId !== await contentHash(agreement) || operation.kind !== 'funding') throw new Error('Funding operation belongs to a different agreement.')
  const preview=deserializeSwapPreview(operation.preview)
  validateLockedProofs(agreement,(preview.sendOutputs || []).map(o=>({secret:new TextDecoder().decode(o.secret),amount:o.blindedMessage.amount})))
  if(amount(preview.fees)>agreement.fundingFeeSats)throw new Error('Funding fee exceeds agreement.')
  await requireBackup(operation,durableBackup)
  const result = plainSwap(await wallet.completeSwap(preview))
  const funding = await verifyFunding(wallet, agreement, result.send)
  return { ...result, funding }
}

function recipientOutput(output, expected) {
  const restored = OutputData.deserialize(output)
  const [kind, secret] = JSON.parse(new TextDecoder().decode(restored.secret))
  if (kind !== 'P2PK' || secret.data !== expected || (secret.tags || []).some(t => t[0] !== 'sigflag' || t.length !== 2 || t[1] !== 'SIG_INPUTS') || (secret.tags || []).length > 1) throw new Error('Payout output is not exclusively locked to its recipient.')
  return restored
}

export async function prepareResolution(wallet, agreement, proofs, allocation) {
  await verifyFunding(wallet, agreement, proofs)
  const fees = amount(wallet.getFeesForProofs(proofs))
  if (fees !== allocation.mintFeeSats || ![allocation.requesterSats, allocation.payerSats].every(n => Number.isSafeInteger(n) && n >= 0) || BigInt(allocation.requesterSats) + BigInt(allocation.payerSats) + BigInt(fees) !== BigInt(agreement.escrowSats)) throw new Error('Resolution allocation or fee does not conserve escrow.')
  const keyset = wallet.getKeyset()
  const groups = Object.fromEntries(['requester', 'payer'].map(role => [role, allocation[`${role}Sats`] ? OutputData.createP2PKData({ pubkey: agreement.escrowKeys[role], sigFlag: 'SIG_INPUTS' }, allocation[`${role}Sats`], keyset).map(o => OutputData.serialize(o)) : []]))
  const outputs = [...groups.requester, ...groups.payer].map(o => OutputData.deserialize(o))
  const preview = await wallet.prepareSwapToReceive(proofs, { requireDleq: true }, { type: 'custom', data: outputs })
  const pkg = SigAll.extractSwapPackage(preview)
  return { agreementId: await contentHash(agreement), kind: 'resolution', revision: crypto.randomUUID(), allocation, groups, preview: serializeSwapPreview(preview), package: SigAll.serializePackage(pkg) }
}

export async function validateResolutionOperation(agreement, proofs, operation) {
  if (operation.kind !== 'resolution' || operation.agreementId !== await contentHash(agreement)) throw new Error('Resolution belongs to another agreement.')
  validateLockedProofs(agreement, proofs)
  const pkg = SigAll.deserializePackage(operation.package)
  if (pkg.type !== 'swap' || pkg.quote || canonical(pkg.inputs) !== canonical(proofs.map(p => ({ secret: p.secret, C: p.C })))) throw new Error('Resolution changes escrow inputs.')
  const groups = ['requester', 'payer'].map(role => operation.groups[role].map(o => recipientOutput(o, agreement.escrowKeys[role])))
  const outputs = groups.flat().map(o => o.blindedMessage)
  const comparable = list => list.map(o => ({ id: o.id, B_: o.B_, amount: amount(o.amount) }))
  if (canonical(comparable(outputs)) !== canonical(comparable(pkg.outputs))) throw new Error('Signing package substitutes payout outputs.')
  const preview = deserializeSwapPreview(operation.preview)
  const original = SigAll.extractSwapPackage(preview)
  if (canonical(comparable(original.outputs)) !== canonical(comparable(outputs)) || canonical(original.inputs) !== canonical(pkg.inputs)) throw new Error('Prepared mint request differs from signing package.')
  const fees = amount(preview.fees)
  if (total(groups[0].map(o => o.blindedMessage)) !== BigInt(operation.allocation.requesterSats) || total(groups[1].map(o => o.blindedMessage)) !== BigInt(operation.allocation.payerSats) || fees !== operation.allocation.mintFeeSats || total(outputs) + BigInt(fees) !== BigInt(agreement.escrowSats)) throw new Error('Payout allocation mismatch.')
  return { pkg, preview }
}

export async function signResolution(agreement, proofs, operation, privateKey) {
  const { pkg } = await validateResolutionOperation(agreement, proofs, operation)
  if (!Object.values(agreement.escrowKeys).includes(bytesToHex(getPubKeyFromPrivKey(hexToBytes(privateKey))))) throw new Error('This key is not a party to the escrow.')
  return { ...operation, package: SigAll.serializePackage(SigAll.signPackage(pkg, privateKey)) }
}

// Excludes accumulated signatures but binds every input, output and allocation.
// A peer-controlled revision string is not an authorization boundary.
export async function resolutionFingerprint(agreement, proofs, operation) {
  const { pkg } = await validateResolutionOperation(agreement, proofs, operation)
  return contentHash({agreementId:operation.agreementId, inputs:pkg.inputs, outputs:pkg.outputs.map(o=>({...o,amount:amount(o.amount)})), allocation:operation.allocation, groups:operation.groups})
}

export async function verifyPayout(wallet, agreement, proofs, operation, payouts) {
  await validateResolutionOperation(agreement,proofs,operation)
  const states=await wallet.checkProofsStates(proofs)
  if(states.length!==proofs.length||states.some(p=>p.state!=='SPENT'))throw new Error('Escrow redemption is not confirmed by the mint.')
  for(const role of ['requester','payer']) {
    const expected=new Map(operation.groups[role].map(o=>{const output=OutputData.deserialize(o);return [new TextDecoder().decode(output.secret),amount(output.blindedMessage.amount)]}))
    const received=payouts?.[role]
    if(!Array.isArray(received)||received.length!==expected.size||new Set(received.map(p=>p.secret)).size!==received.length)throw new Error('Payout proof set is incomplete.')
    for(const p of received)if(expected.get(p.secret)!==amount(p.amount)||!hasValidDleq(p,wallet.getKeyset(p.id),{require:true}))throw new Error('Invalid payout cryptographic evidence.')
  }
  return {agreementId:await contentHash(agreement),verified:true,verifiedAt:Math.floor(Date.now()/1000)}
}

export async function prepareClaim(wallet, agreement, proofs, privateKey) {
  if(!proofs?.length)throw new Error('No payout to collect.')
  const pubkey=bytesToHex(getPubKeyFromPrivKey(hexToBytes(privateKey)))
  for(const p of proofs) {
    const [kind,lock]=JSON.parse(p.secret)
    if(kind!=='P2PK'||lock.data!==pubkey||!hasValidDleq(p,wallet.getKeyset(p.id),{require:true}))throw new Error('Payout does not belong to this key.')
  }
  const preview=await wallet.prepareSwapToReceive(proofs,{requireDleq:true})
  return {kind:'claim',agreementId:await contentHash(agreement),revision:crypto.randomUUID(),preview:serializeSwapPreview(preview)}
}

export async function completeClaim(wallet, agreement, operation, privateKey, backup) {
  if(operation.kind!=='claim'||operation.agreementId!==await contentHash(agreement))throw new Error('Wrong payout collection operation.')
  await requireBackup(operation,backup)
  return plainSwap(await wallet.completeSwap(deserializeSwapPreview(operation.preview),privateKey))
}

export async function completeResolution(wallet, agreement, proofs, operation, durableBackup) {
  const { pkg, preview } = await validateResolutionOperation(agreement, proofs, operation)
  const transcript = pkg.inputs.map(p => p.secret + p.C).join('') + pkg.outputs.map(o => String(amount(o.amount)) + o.B_).join('')
  const split=operation.allocation.requesterSats>0&&operation.allocation.payerSats>0
  const eligible=split?[agreement.escrowKeys.requester,agreement.escrowKeys.payer]:Object.values(agreement.escrowKeys)
  if (!meetsSignerThreshold(pkg.witness?.signatures || [], transcript, eligible, 2)) throw new Error(split?'A split requires both participants’ signatures.':'Two distinct escrow signatures are required.')
  await requireBackup(operation,durableBackup)
  const result = plainSwap(await wallet.completeSwap(SigAll.mergeSwapPackage(pkg, preview)))
  // Match recipient outputs by their secrets, not by a potentially changed order.
  const recipientSecrets = role => new Set(operation.groups[role].map(o => new TextDecoder().decode(OutputData.deserialize(o).secret)))
  const all = [...result.keep, ...result.send]
  const payouts = Object.fromEntries(['requester', 'payer'].map(role => [role, all.filter(p => recipientSecrets(role).has(p.secret))]))
  if (total(payouts.requester) !== BigInt(operation.allocation.requesterSats) || total(payouts.payer) !== BigInt(operation.allocation.payerSats)) throw new Error('Mint response did not produce the agreed payouts. Reconcile the saved operation.')
  return { payouts, redemption: { agreementId: await contentHash(agreement), verified: true, verifiedAt: Math.floor(Date.now() / 1000) } }
}

export async function requireBackup(operation, backup) {
  const receipt=await backup(operation)
  if(!receipt || receipt.operationHash!==await contentHash(operation) || receipt.verifiedCopies<2 || !Number.isFinite(receipt.checkedAt) || Date.now()-receipt.checkedAt>60000 || receipt.checkedAt>Date.now()+1000 || new Set(receipt.results?.filter(r=>r.verified).map(r=>new URL(r.server).hostname)).size<2)throw new Error('Two freshly verified independent backups of this operation are required.')
}
