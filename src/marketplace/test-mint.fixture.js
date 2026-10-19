import { Amount, OutputData, createNewMintKeys, createBlindSignature, createDLEQProof, pointFromHex, SigAll, meetsSignerThreshold, serializeSwapPreview } from '@cashu/cashu-ts'
import { bytesToHex } from 'nostr-tools/utils'
// In-process test mint: real blind signatures and DLEQ proofs, zero-value test
// money only. Its ledger checks spending signatures and caches exact retries.
export function testMint(agreement) {
  const keys = createNewMintKeys(12)
  const keyset = { id: keys.keysetId, keys: Object.fromEntries(Object.entries(keys.pubKeys).map(([amount,key]) => [amount,bytesToHex(key)])) }
  const spent = new Set(), cache = new Map()
  const issue = outputs => outputs.map(o => {
    const B = pointFromHex(o.blindedMessage.B_), amount = Number(o.blindedMessage.amount), sk = keys.privKeys[amount]
    const signature = createBlindSignature(B,sk,keyset.id), dleq = createDLEQProof(B,sk)
    return o.toProof({ amount: Amount.from(amount), id: keyset.id, C_: signature.C_.toHex(true), dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) } },keyset)
  })
  return {
    issue,
    getKeyset: () => keyset,
    getFeesForProofs: () => Amount.from(0),
    checkProofsStates: async proofs => proofs.map(p => ({ state: spent.has(p.secret) ? 'SPENT' : 'UNSPENT' })),
    prepareSwapToSend: async (amount,inputs,config,output) => ({ amount: Amount.from(amount), fees: Amount.from(0), keysetId:keyset.id, inputs, sendOutputs: OutputData.createP2PKData(output.send.options,amount,keyset), keepOutputs: OutputData.createRandomData(inputs.reduce((n,p)=>n+Number(p.amount),0)-Number(amount),keyset) }),
    prepareSwapToReceive: async (inputs,config,output) => ({ amount: Amount.from(1000), fees: Amount.from(0), keysetId:keyset.id, inputs, keepOutputs:output?.data || OutputData.createRandomData(inputs.reduce((n,p)=>n+Number(p.amount),0),keyset), sendOutputs:[] }),
    completeSwap: async (preview, privateKey) => {
      const id = JSON.stringify(serializeSwapPreview(preview))
      if (cache.has(id)) return cache.get(id)
      if (preview.inputs.some(p => spent.has(p.secret))) throw new Error('already spent')
      if (preview.inputs[0]?.secret.startsWith('["P2PK"') && JSON.parse(preview.inputs[0].secret)[1].tags?.some(t=>t[1]==='SIG_ALL')) {
        const pkg = SigAll.extractSwapPackage(preview)
        const transcript = pkg.inputs.map(p => p.secret+p.C).join('') + pkg.outputs.map(o => String(o.amount)+o.B_).join('')
        const witness = typeof preview.inputs[0].witness === 'string' ? JSON.parse(preview.inputs[0].witness) : preview.inputs[0].witness
        if (!meetsSignerThreshold(witness?.signatures || [],transcript,Object.values(agreement.escrowKeys),2)) throw new Error('mint rejected missing signatures')
      }
      const result = { keep:issue(preview.keepOutputs || []),send:issue(preview.sendOutputs || []) }
      preview.inputs.forEach(p => spent.add(p.secret));cache.set(id,result);return result
    },
  }
}
