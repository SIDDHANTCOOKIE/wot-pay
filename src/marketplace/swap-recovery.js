import { hasValidDleq } from '@cashu/cashu-ts'

const amount = n => typeof n?.toNumber === 'function' ? n.toNumber() : Number(n)
export const UNCERTAIN = 'Mint operation outcome is uncertain. Keep this saved operation and reconcile it later; do not fund or sign again.'
const uncertain = detail => { const e = new Error(`${detail} ${UNCERTAIN}`); e.uncertain = true; return e }

// Completes a saved swap exactly once. A lost response is recovered from the
// mint's NUT-09 record of the exact saved blinded outputs, never by creating
// replacement outputs, so a finite NUT-19 cache cannot strand the operation.
export async function completeOrRestoreSwap(wallet, preview, privateKey) {
  try { return await wallet.completeSwap(preview, privateKey) }
  catch (error) {
    const states = await wallet.checkProofsStates(preview.inputs).catch(() => null)
    if (!states || states.length !== preview.inputs.length) throw uncertain('The mint did not report every input state.')
    if (states.every(s => s.state === 'UNSPENT')) throw error
    if (!states.every(s => s.state === 'SPENT')) throw uncertain('Some inputs are pending or only partly spent.')
    return restoreSwap(wallet, preview)
  }
}

export async function restoreSwap(wallet, preview) {
  const keep = preview.keepOutputs || [], send = preview.sendOutputs || []
  const proofs = await restoreOutputs(wallet, [...keep, ...send])
  return { keep: proofs.slice(0, keep.length), send: proofs.slice(keep.length) }
}

// NUT-04 counterpart: an unpaid quote surfaces the error (pay, then retry the
// same saved mint); a paid but unissued quote surfaces it too, because retrying
// the identical outputs is safe; an issued quote restores the saved outputs.
export async function completeOrRestoreMint(wallet, preview) {
  try { return await wallet.completeMint(preview) }
  catch (error) {
    const quote = await wallet.checkMintQuoteBolt11(preview.quote.quote).catch(() => null)
    if (!quote) throw uncertain('The mint did not report the quote state.')
    if (quote.state !== 'ISSUED') throw error
    return restoreOutputs(wallet, preview.outputData)
  }
}

// Restores exactly these saved outputs, in order.
export async function restoreOutputs(wallet, list) {
  const saved = new Map()
  for (const output of list) {
    const b = output.blindedMessage
    if (saved.has(b.B_)) throw new Error('Saved operation repeats a blinded output.')
    saved.set(b.B_, output)
  }
  if (!saved.size) throw uncertain('Saved operation has no outputs to restore.')
  const outputs = [...saved.values()].map(o => ({ id: o.blindedMessage.id, amount: amount(o.blindedMessage.amount), B_: o.blindedMessage.B_ }))
  const response = await wallet.mint.restore({ outputs }).catch(() => { throw uncertain('Swap restoration request failed.') })
  if (!Array.isArray(response?.outputs) || !Array.isArray(response?.signatures) || response.outputs.length !== response.signatures.length) throw new Error('Malformed mint restoration response.')
  const signatures = new Map()
  response.outputs.forEach((returned, i) => {
    const original = saved.get(returned?.B_), sig = response.signatures[i]
    if (!original || signatures.has(returned.B_)) throw new Error('Mint restoration returned an unexpected or duplicated output.')
    const b = original.blindedMessage
    if (returned.id !== b.id || amount(returned.amount) !== amount(b.amount) || sig?.id !== b.id || amount(sig.amount) !== amount(b.amount) || typeof sig.C_ !== 'string') throw new Error('Mint restoration substituted an output amount or keyset.')
    signatures.set(returned.B_, sig)
  })
  // Partial restoration means the swap may have spent the inputs elsewhere.
  if (signatures.size !== saved.size) throw uncertain('The mint restored only part of the saved outputs.')
  await wallet.ensureOperableKeysets([...new Set(outputs.map(o => o.id))])
  return list.map(output => {
    const keyset = wallet.getKeyset(output.blindedMessage.id)
    const proof = output.toProof(signatures.get(output.blindedMessage.B_), keyset)
    if (!hasValidDleq(proof, keyset, { require: true })) throw new Error('Restored output lacks valid mint cryptographic evidence.')
    return proof
  })
}
