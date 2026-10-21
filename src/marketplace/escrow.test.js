import { expect, it } from 'vitest'
import { Amount, OutputData, createNewMintKeys, createBlindSignature, createDLEQProof, pointFromHex, SigAll, meetsSignerThreshold, serializeSwapPreview } from '@cashu/cashu-ts'
import { bytesToHex } from 'nostr-tools/utils'
import { testTrade } from './fixtures.js'
import { contentHash, canonical } from './protocol.js'
import { completeFunding, prepareFunding, verifyFunding, validateLockedProofs, prepareResolution, signResolution, completeResolution } from './escrow.js'

import { testMint } from './test-mint.fixture.js'
const backup=async operation=>({operationHash:await contentHash(operation),verifiedCopies:2,checkedAt:Date.now(),results:[{server:'https://one.example',verified:true},{server:'https://two.example',verified:true}]})
async function funded() {
  const fixture = await testTrade(), wallet = testMint(fixture.agreement)
  const input = wallet.issue(OutputData.createRandomData(1000,wallet.getKeyset()))
  const operation = await prepareFunding(wallet,fixture.agreement,input)
  const result = await completeFunding(wallet,fixture.agreement,operation,backup)
  return {...fixture,wallet,operation,input,...result}
}
it('funds permanent 2-of-3 locks and verifies real mint DLEQ evidence',async()=>{
  const t=await funded()
  expect(t.funding.verified).toBe(true)
  expect(validateLockedProofs(t.agreement,t.send)).toBe(t.send)
  expect(validateLockedProofs(JSON.parse(canonical(t.agreement)),t.send)).toBe(t.send)
  const tampered=t.send.map(p=>({...p,secret:p.secret.replace('SIG_ALL','SIG_INPUTS')}))
  expect(()=>validateLockedProofs(t.agreement,tampered)).toThrow()
  await expect(verifyFunding(t.wallet,t.agreement,t.send.map(p=>({...p,dleq:undefined})))).rejects.toThrow('cryptographic')
})
it.each([[0,1000],[1000,0],[400,600]])('releases/refunds/splits %s/%s only with two signatures and replays the identical request',async(requesterSats,payerSats)=>{
  const t=await funded()
  const op=await prepareResolution(t.wallet,t.agreement,t.send,{requesterSats,payerSats,mintFeeSats:0,reason:'test'})
  const one=await signResolution(t.agreement,t.send,op,t.keys.requester.secret)
  await expect(completeResolution(t.wallet,t.agreement,t.send,one,backup)).rejects.toThrow(/signatures/)
  const two=await signResolution(t.agreement,t.send,one,t.keys.payer.secret)
  const result=await completeResolution(t.wallet,t.agreement,t.send,two,backup)
  expect(result.redemption.verified).toBe(true)
  const retry=await completeResolution(t.wallet,t.agreement,t.send,two,backup)
  expect(retry.payouts).toEqual(result.payouts)
  expect(retry.redemption.agreementId).toBe(result.redemption.agreementId)
  expect(retry.redemption.verified).toBe(true)
})
it('rejects output substitution and blocks spending if durable backup fails',async()=>{
  const t=await funded()
  const op=await prepareResolution(t.wallet,t.agreement,t.send,{requesterSats:0,payerSats:1000,mintFeeSats:0,reason:'release'})
  const changed=structuredClone(op)
  changed.groups.payer[0].blindingFactor='1'
  await expect(signResolution(t.agreement,t.send,changed,t.keys.requester.secret)).rejects.toThrow()
  const one=await signResolution(t.agreement,t.send,op,t.keys.requester.secret)
  const two=await signResolution(t.agreement,t.send,one,t.keys.arbitrator.secret)
  await expect(completeResolution(t.wallet,t.agreement,t.send,two,async()=>{throw new Error('backup unavailable')})).rejects.toThrow('backup unavailable')
  expect((await verifyFunding(t.wallet,t.agreement,t.send)).verified).toBe(true)
})
it('locks escrow with the agreed requester refund timelock and rejects altered locks',async()=>{
  const t=await funded()
  const lock=JSON.parse(t.send[0].secret)[1]
  expect(new Map(lock.tags.map(x=>[x[0],x.slice(1)])).get('locktime')).toEqual([String(t.agreement.refundAfter)])
  const alter=(from,to)=>t.send.map(p=>({...p,secret:p.secret.replace(from,to)}))
  expect(()=>validateLockedProofs(t.agreement,alter(String(t.agreement.refundAfter),String(t.agreement.refundAfter-1)))).toThrow('timelock')
  expect(()=>validateLockedProofs(t.agreement,alter(`["refund","${t.agreement.escrowKeys.requester}"]`,`["refund","${t.agreement.escrowKeys.payer}"]`))).toThrow('timelock')
  expect(()=>validateLockedProofs({...t.agreement,refundAfter:t.agreement.refundAfter+1},t.send)).toThrow()
})
it('lets the requester alone refund only after the locktime, on both the client and the mint clock',async()=>{
  const t=await funded(),after=t.agreement.refundAfter
  const refund=await prepareResolution(t.wallet,t.agreement,t.send,{requesterSats:1000,payerSats:0,mintFeeSats:0,reason:'timelock'})
  const solo=await signResolution(t.agreement,t.send,refund,t.keys.requester.secret)
  await expect(completeResolution(t.wallet,t.agreement,t.send,solo,backup,after-1)).rejects.toThrow('Two distinct')
  // A client that lies about the time is still stopped by the mint's locktime check.
  await expect(completeResolution(t.wallet,t.agreement,t.send,solo,backup,after)).rejects.toThrow('mint rejected')
  t.wallet.faults.time=()=>after
  const payout=await prepareResolution(t.wallet,t.agreement,t.send,{requesterSats:0,payerSats:1000,mintFeeSats:0,reason:'not a refund'})
  await expect(completeResolution(t.wallet,t.agreement,t.send,await signResolution(t.agreement,t.send,payout,t.keys.requester.secret),backup,after)).rejects.toThrow('Two distinct')
  t.wallet.faults.lose=true
  const result=await completeResolution(t.wallet,t.agreement,t.send,solo,backup,after)
  expect(result.payouts.requester.reduce((n,p)=>n+p.amount,0)).toBe(1000)
  expect(t.wallet.faults.restoreCalls).toBe(1)
})
it('keeps the 2-of-3 release valid after the locktime',async()=>{
  const t=await funded(),after=t.agreement.refundAfter
  t.wallet.faults.time=()=>after+1
  const op=await prepareResolution(t.wallet,t.agreement,t.send,{requesterSats:0,payerSats:1000,mintFeeSats:0,reason:'late release'})
  const two=await signResolution(t.agreement,t.send,await signResolution(t.agreement,t.send,op,t.keys.payer.secret),t.keys.arbitrator.secret)
  expect((await completeResolution(t.wallet,t.agreement,t.send,two,backup,after+1)).payouts.payer.reduce((n,p)=>n+p.amount,0)).toBe(1000)
})
