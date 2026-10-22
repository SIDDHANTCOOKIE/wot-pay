import { Wallet, OutputData, SigAll, serializeSwapPreview, deserializeSwapPreview, getPubKeyFromPrivKey, createRandomSecretKey, hasValidDleq, meetsSignerThreshold } from '@cashu/cashu-ts'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import { canonical, contentHash, validateAgreement } from './protocol.js'
import { assertSwapRecoveryPolicy } from './mint-policy.js'
import { completeOrRestoreSwap, completeOrRestoreMint } from './swap-recovery.js'

const amount = n => typeof n?.toNumber === 'function' ? n.toNumber() : Number(n)
const total = proofs => proofs.reduce((n,p) => n + BigInt(amount(p.amount)), 0n)
export const plainSwap = result => Object.fromEntries(['keep','send'].map(role=>[role,(result[role]||[]).map(p=>({...p,amount:amount(p.amount)}))]))
export function createEscrowKey() {
  const secret = createRandomSecretKey()
  return { secret: bytesToHex(secret), pubkey: bytesToHex(getPubKeyFromPrivKey(secret)) }
}
const escrowKeys = agreement => ['requester','payer','arbitrator'].map(role=>agreement.escrowKeys[role])
export const escrowLock = agreement => ({ pubkey: escrowKeys(validateAgreement(agreement)), requiredSignatures: 2, sigFlag: 'SIG_ALL', locktime: agreement.refundAfter, refundKeys: [agreement.escrowKeys.requester] })

export function validateLockedProofs(agreement, proofs) {
  validateAgreement(agreement)
  if (!Array.isArray(proofs) || !proofs.length || proofs.length > 512 || new Set(proofs.map(p => p.secret)).size !== proofs.length || total(proofs) !== BigInt(agreement.escrowSats)) throw new Error('Escrow amount or proof set does not match.')
  const expected = escrowKeys(agreement)
  let policy
  for (const p of proofs) {
    if (!Number.isSafeInteger(amount(p.amount)) || amount(p.amount) <= 0) throw new Error('Invalid proof amount.')
    const [kind, secret] = JSON.parse(p.secret)
    if (kind !== 'P2PK' || !Array.isArray(secret.tags) || secret.tags.length !== 5) throw new Error('Escrow must use the agreed 2-of-3 lock with a requester refund timelock.')
    const tags = new Map(secret.tags.map(t => [t[0], t.slice(1)]))
    if (tags.size !== 5 || canonical(tags.get('sigflag')) !== '["SIG_ALL"]' || canonical(tags.get('n_sigs')) !== '["2"]' || canonical([secret.data, ...(tags.get('pubkeys') || [])]) !== canonical(expected)) throw new Error('Wrong escrow keys, signature threshold or output binding.')
    if (canonical(tags.get('locktime')) !== canonical([String(agreement.refundAfter)]) || canonical(tags.get('refund')) !== canonical([agreement.escrowKeys.requester])) throw new Error('Wrong refund timelock or refund key.')
    const next = canonical({ data: secret.data, tags: secret.tags })
    if (policy && policy !== next) throw new Error('Mixed spending conditions.')
    policy = next
  }
  return proofs
}

// restoreVerified: this exact mint passed a live lost-response NUT-09 test.
export async function connectMint(agreement, { wallet = new Wallet(agreement.mint), restoreVerified = false } = {}) {
  validateAgreement(agreement)
  await wallet.loadMint()
  const info = wallet.getMintInfo()
  for (const nut of [7, 11, 12]) if (!info.isSupported(nut).supported) throw new Error(`Mint must support NUT-${nut} for recoverable escrow.`)
  assertSwapRecoveryPolicy(info.isSupported(19), { supported: info.isSupported(9).supported, verified: restoreVerified })
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
  const result = plainSwap(await completeOrRestoreSwap(wallet,preview))
  const funding = await verifyFunding(wallet, agreement, result.send)
  return { ...result, funding }
}

// Lightning funding (NUT-04): the requester pays an invoice the mint itself
// issued, and the mint signs outputs that are already escrow-locked, so the
// sats never pass through anyone's spendable balance. The quote is locked
// (NUT-20) to the requester's per-trade key so nobody else can mint it. The
// whole preview is saved and replicated before the invoice is shown.
const lockedSecrets = outputData => outputData.map(o => ({ secret: new TextDecoder().decode(o.secret), amount: o.blindedMessage.amount }))
const serializeMint = p => ({ method: p.method, quote: { quote: p.quote.quote, request: p.quote.request, expiry: p.quote.expiry ?? null, pubkey: p.quote.pubkey ?? null, amount: amount(p.quote.amount) }, signature: p.payload.signature ?? null, legacySignature: p.legacySignature ?? null, outputData: p.outputData.map(o => OutputData.serialize(o)) })
export function deserializeMint(s) {
  const outputData = s.outputData.map(o => OutputData.deserialize(o))
  return { method: s.method, quote: s.quote, outputData, keysetId: outputData[0]?.blindedMessage.id, payload: { quote: s.quote.quote, outputs: outputData.map(o => o.blindedMessage), ...(s.signature ? { signature: s.signature } : {}) }, ...(s.legacySignature ? { legacySignature: s.legacySignature } : {}) }
}
export async function prepareLightningFunding(wallet, agreement, quoteKey) {
  validateAgreement(agreement)
  if (!wallet.getMintInfo().isSupported(20).supported) throw new Error('This mint cannot lock Lightning quotes (NUT-20). Fund with ecash instead.')
  const quote = await wallet.createLockedMintQuote(agreement.escrowSats, quoteKey.pubkey)
  if (amount(quote.amount) !== agreement.escrowSats || quote.pubkey && quote.pubkey !== quoteKey.pubkey) throw new Error('The mint returned a quote for different terms.')
  const preview = await wallet.prepareMint('bolt11', agreement.escrowSats, quote, { privkey: quoteKey.secret }, { type: 'p2pk', options: escrowLock(agreement) })
  validateLockedProofs(agreement, lockedSecrets(preview.outputData))
  return { agreementId: await contentHash(agreement), kind: 'lightning-funding', revision: crypto.randomUUID(), invoice: quote.request, expiry: quote.expiry ?? null, preview: serializeMint(preview) }
}
// Returns null while the invoice is unpaid; otherwise mints exactly once.
export async function completeLightningFunding(wallet, agreement, operation, durableBackup) {
  if (operation.kind !== 'lightning-funding' || operation.agreementId !== await contentHash(agreement)) throw new Error('Funding operation belongs to a different agreement.')
  const preview = deserializeMint(operation.preview)
  validateLockedProofs(agreement, lockedSecrets(preview.outputData))
  const { state } = await wallet.checkMintQuoteBolt11(preview.quote.quote)
  if (state === 'UNPAID') return null
  await requireBackup(operation, durableBackup)
  const send = (await completeOrRestoreMint(wallet, preview)).map(p => ({ ...p, amount: amount(p.amount) }))
  return { keep: [], send, funding: await verifyFunding(wallet, agreement, send) }
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

// Peers send resolutions without the mint preview: it repeats the escrow
// proofs the receiver already holds and the outputs in groups, and roughly
// doubled the message, pushing payouts toward relay size limits. The receiver
// rebuilds it and validation then requires it to match the signed package.
export const wireOperation = ({ preview, ...operation }) => operation
export async function hydrateOperation(wallet, agreement, proofs, operation) {
  if (operation.preview) return operation
  if (operation.kind !== 'resolution') throw new Error('Unknown operation from peer.')
  validateLockedProofs(agreement, proofs)
  const outputs = [...operation.groups.requester, ...operation.groups.payer].map(o => recipientOutput(o, agreement.escrowKeys[operation.groups.requester.includes(o) ? 'requester' : 'payer']))
  const preview = await wallet.prepareSwapToReceive(proofs, { requireDleq: true }, { type: 'custom', data: outputs })
  const hydrated = { ...operation, preview: serializeSwapPreview(preview) }
  await validateResolutionOperation(agreement, proofs, hydrated)
  return hydrated
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
  return plainSwap(await completeOrRestoreSwap(wallet,deserializeSwapPreview(operation.preview),privateKey))
}

// After refundAfter the requester's signature alone may return the escrow to
// the requester (NUT-11 refund path); the mint enforces the locktime too.
export async function completeResolution(wallet, agreement, proofs, operation, durableBackup, now = Math.floor(Date.now() / 1000)) {
  const { pkg, preview } = await validateResolutionOperation(agreement, proofs, operation)
  const transcript = pkg.inputs.map(p => p.secret + p.C).join('') + pkg.outputs.map(o => String(amount(o.amount)) + o.B_).join('')
  const split=operation.allocation.requesterSats>0&&operation.allocation.payerSats>0
  const eligible=split?[agreement.escrowKeys.requester,agreement.escrowKeys.payer]:Object.values(agreement.escrowKeys)
  const signatures = pkg.witness?.signatures || []
  const refundPath = operation.allocation.payerSats === 0 && now >= agreement.refundAfter && meetsSignerThreshold(signatures, transcript, [agreement.escrowKeys.requester], 1)
  if (!refundPath && !meetsSignerThreshold(signatures, transcript, eligible, 2)) throw new Error(split?'A split requires both participants’ signatures.':'Two distinct escrow signatures are required.')
  await requireBackup(operation,durableBackup)
  const result = plainSwap(await completeOrRestoreSwap(wallet,SigAll.mergeSwapPackage(pkg, preview)))
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
