import { Amount, createNewMintKeys, createBlindSignature, createDLEQProof, pointFromHex, SigAll, meetsSignerThreshold, serializeSwapPreview, OutputData } from '@cashu/cashu-ts'
import { bytesToHex } from 'nostr-tools/utils'
// In-process test mint: real blind signatures and DLEQ proofs, zero-value test
// money only. Its ledger checks spending signatures, optionally caches exact
// retries (NUT-19), and keeps every signature for NUT-09 restoration.
export function testMint(agreement, { cache = true } = {}) {
  const keysets = new Map()
  let active
  const rotate = () => {
    const keys = createNewMintKeys(12)
    const keyset = { id: keys.keysetId, keys: Object.fromEntries(Object.entries(keys.pubKeys).map(([amount,key]) => [amount,bytesToHex(key)])) }
    keysets.set(keyset.id, { keyset, keys }); active = keyset.id
    return keyset
  }
  rotate()
  const getKeyset = (id = active) => { const k = keysets.get(id); if (!k) throw new Error('unknown keyset'); return k.keyset }
  const spent = new Set(), pending = new Set(), responses = new Map(), signed = new Map()
  const faults = { lose: false, fail: false, restore: r => r, restoreCalls: 0 }
  const sign = o => {
    const b = o.blindedMessage, { keys } = keysets.get(b.id), amount = Number(b.amount), B = pointFromHex(b.B_), sk = keys.privKeys[amount]
    const sig = { id: b.id, amount, C_: createBlindSignature(B,sk,b.id).C_.toHex(true), dleq: (({e,s}) => ({ e: bytesToHex(e), s: bytesToHex(s) }))(createDLEQProof(B,sk)) }
    signed.set(b.B_, sig)
    return o.toProof({ ...sig, amount: Amount.from(amount) }, getKeyset(b.id))
  }
  const issue = outputs => outputs.map(sign)
  return {
    issue, rotate, getKeyset, faults, signed,
    expireCache: () => responses.clear(),
    markPending: proofs => proofs.forEach(p => pending.add(p.secret)),
    spendElsewhere: proofs => proofs.forEach(p => spent.add(p.secret)),
    ensureOperableKeysets: async ids => { for (const id of ids) getKeyset(id) },
    getFeesForProofs: () => Amount.from(0),
    checkProofsStates: async proofs => proofs.map(p => ({ state: pending.has(p.secret) ? 'PENDING' : spent.has(p.secret) ? 'SPENT' : 'UNSPENT' })),
    mint: {
      restore: async ({ outputs }) => {
        faults.restoreCalls++
        const found = outputs.filter(o => signed.has(o.B_))
        return faults.restore({ outputs: found.map(o => ({ ...o })), signatures: found.map(o => ({ ...signed.get(o.B_) })) })
      },
    },
    prepareSwapToSend: async (amount,inputs,config,output) => ({ amount: Amount.from(amount), fees: Amount.from(0), keysetId:active, inputs, sendOutputs: OutputData.createP2PKData(output.send.options,amount,getKeyset()), keepOutputs: OutputData.createRandomData(inputs.reduce((n,p)=>n+Number(p.amount),0)-Number(amount),getKeyset()) }),
    prepareSwapToReceive: async (inputs,config,output) => ({ amount: Amount.from(1000), fees: Amount.from(0), keysetId:active, inputs, keepOutputs:output?.data || OutputData.createRandomData(inputs.reduce((n,p)=>n+Number(p.amount),0),getKeyset()), sendOutputs:[] }),
    completeSwap: async preview => {
      if (faults.fail) { faults.fail = false; throw new Error('network error: request not delivered') }
      const id = JSON.stringify(serializeSwapPreview(preview))
      if (cache && responses.has(id)) return responses.get(id)
      if (preview.inputs.some(p => spent.has(p.secret) || pending.has(p.secret))) throw new Error('already spent')
      if (preview.inputs[0]?.secret.startsWith('["P2PK"') && JSON.parse(preview.inputs[0].secret)[1].tags?.some(t=>t[1]==='SIG_ALL')) {
        const pkg = SigAll.extractSwapPackage(preview)
        const transcript = pkg.inputs.map(p => p.secret+p.C).join('') + pkg.outputs.map(o => String(o.amount)+o.B_).join('')
        const witness = typeof preview.inputs[0].witness === 'string' ? JSON.parse(preview.inputs[0].witness) : preview.inputs[0].witness
        if (!meetsSignerThreshold(witness?.signatures || [],transcript,Object.values(agreement.escrowKeys),2)) throw new Error('mint rejected missing signatures')
      }
      const result = { keep:issue(preview.keepOutputs || []),send:issue(preview.sendOutputs || []) }
      preview.inputs.forEach(p => spent.add(p.secret))
      if (cache) responses.set(id,result)
      if (faults.lose) { faults.lose = false; throw new Error('network error: response lost') }
      return result
    },
  }
}
