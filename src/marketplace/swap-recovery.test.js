import { expect, it } from 'vitest'
import { OutputData, deserializeSwapPreview } from '@cashu/cashu-ts'
import { testTrade } from './fixtures.js'
import { testMint } from './test-mint.fixture.js'
import { contentHash } from './protocol.js'
import { connectMint, prepareFunding, completeFunding, verifyFunding, prepareResolution, signResolution, completeResolution, verifyPayout, prepareClaim, completeClaim } from './escrow.js'
import { prepareFee, completeFee, verifyFeeProofs } from './fees.js'
import { completeOrRestoreSwap } from './swap-recovery.js'

const backup=async operation=>({operationHash:await contentHash(operation),verifiedCopies:2,checkedAt:Date.now(),results:[{server:'https://one.example',verified:true},{server:'https://two.example',verified:true}]})
const ids=proofs=>proofs.map(p=>`${p.secret}:${p.C}:${Number(p.amount)}`).sort()
const savedSecrets=outputs=>outputs.map(o=>new TextDecoder().decode(o.secret)).sort()
async function setup(options) {
  const t=await testTrade(),wallet=testMint(t.agreement,options)
  const input=wallet.issue(OutputData.createRandomData(1005,wallet.getKeyset()))
  return {...t,wallet,input,operation:await prepareFunding(wallet,t.agreement,input)}
}

it('restores the exact saved funding outputs when the response is lost and the mint keeps no cache',async()=>{
  const t=await setup({cache:false})
  t.wallet.faults.lose=true
  const signedBefore=t.wallet.signed.size
  const funded=await completeFunding(t.wallet,t.agreement,t.operation,backup)
  const preview=deserializeSwapPreview(t.operation.preview)
  expect(t.wallet.faults.restoreCalls).toBe(1)
  expect(t.wallet.signed.size-signedBefore).toBe(preview.sendOutputs.length+preview.keepOutputs.length)
  expect(funded.send.map(p=>p.secret).sort()).toEqual(savedSecrets(preview.sendOutputs))
  expect(funded.keep.map(p=>p.secret).sort()).toEqual(savedSecrets(preview.keepOutputs))
  expect(funded.funding.verified).toBe(true)
  // A later retry after the operation completed restores the same proofs again; nothing is re-funded.
  const again=await completeFunding(t.wallet,t.agreement,t.operation,backup)
  expect(ids(again.send)).toEqual(ids(funded.send))
  expect(ids(again.keep)).toEqual(ids(funded.keep))
  expect(t.wallet.signed.size-signedBefore).toBe(preview.sendOutputs.length+preview.keepOutputs.length)
})

it('restores after a finite cache expired and the mint rotated its keyset',async()=>{
  const t=await setup()
  const first=await completeFunding(t.wallet,t.agreement,t.operation,backup)
  t.wallet.expireCache();t.wallet.rotate()
  const retry=await completeFunding(t.wallet,t.agreement,t.operation,backup)
  expect(ids(retry.send)).toEqual(ids(first.send))
  expect(retry.send.every(p=>p.id===first.send[0].id&&p.id!==t.wallet.getKeyset().id)).toBe(true)
})

it('surfaces an undelivered request unchanged so the identical saved swap can be retried',async()=>{
  const t=await setup({cache:false})
  t.wallet.faults.fail=true
  await expect(completeFunding(t.wallet,t.agreement,t.operation,backup)).rejects.toThrow('not delivered')
  expect(t.wallet.faults.restoreCalls).toBe(0)
  expect((await t.wallet.checkProofsStates(t.input)).every(s=>s.state==='UNSPENT')).toBe(true)
  expect((await completeFunding(t.wallet,t.agreement,t.operation,backup)).funding.verified).toBe(true)
})

it('keeps the operation uncertain for pending, partly spent or elsewhere-spent inputs',async()=>{
  for(const fault of ['pending','partial','elsewhere']) {
    const t=await setup({cache:false})
    if(fault==='pending')t.wallet.markPending(t.input)
    if(fault==='partial')t.wallet.spendElsewhere(t.input.slice(0,1))
    if(fault==='elsewhere')t.wallet.spendElsewhere(t.input)
    const error=await completeFunding(t.wallet,t.agreement,t.operation,backup).catch(e=>e)
    expect(error.uncertain).toBe(true)
    expect(error.message).toMatch(/do not fund or sign again/)
    expect(t.wallet.faults.restoreCalls).toBe(fault==='elsewhere'?1:0)
  }
})

it.each([
  ['drops an output',r=>({outputs:r.outputs.slice(1),signatures:r.signatures.slice(1)}),'only part'],
  ['adds an unknown output',r=>({outputs:[...r.outputs,{...r.outputs[0],B_:'02'+'ab'.repeat(32)}],signatures:[...r.signatures,r.signatures[0]]}),'unexpected'],
  ['duplicates an output',r=>({outputs:[...r.outputs,r.outputs[0]],signatures:[...r.signatures,r.signatures[0]]}),'duplicated'],
  ['changes an amount',r=>({...r,signatures:r.signatures.map((s,i)=>i?s:{...s,amount:s.amount*2})}),'substituted'],
  ['changes a keyset',r=>({...r,outputs:r.outputs.map((o,i)=>i?o:{...o,id:'00'+'ff'.repeat(7)})}),'substituted'],
  ['swaps signatures between outputs',r=>({...r,signatures:r.signatures.map((s,i,all)=>({...s,C_:all[(i+1)%all.length].C_}))}),/DLEQ|cryptographic/],
  ['strips DLEQ evidence',r=>({...r,signatures:r.signatures.map(({dleq,...s})=>s)}),'Restored output lacks'],
  ['mismatches array lengths',r=>({...r,signatures:r.signatures.slice(1)}),'Malformed'],
])('rejects a restoration response that %s',async(name,tamper,message)=>{
  const t=await setup({cache:false})
  t.wallet.faults.lose=true;t.wallet.faults.restore=tamper
  await expect(completeFunding(t.wallet,t.agreement,t.operation,backup)).rejects.toThrow(message)
})

it('rejects a saved operation that repeats a blinded output before contacting restore',async()=>{
  const t=await setup({cache:false})
  const preview=deserializeSwapPreview(t.operation.preview)
  preview.keepOutputs=[...preview.keepOutputs,preview.keepOutputs[0]]
  t.wallet.faults.lose=true
  await t.wallet.completeSwap({...preview,keepOutputs:preview.keepOutputs.slice(0,-1)}).catch(()=>{})
  await expect(completeOrRestoreSwap(t.wallet,preview)).rejects.toThrow('repeats')
})

it('recovers lost payout and collection responses through the same adapter',async()=>{
  const t=await setup({cache:false})
  const funded=await completeFunding(t.wallet,t.agreement,t.operation,backup)
  const op=await prepareResolution(t.wallet,t.agreement,funded.send,{requesterSats:400,payerSats:600,mintFeeSats:0,reason:'mutual split'})
  const signed=await signResolution(t.agreement,funded.send,await signResolution(t.agreement,funded.send,op,t.keys.requester.secret),t.keys.payer.secret)
  t.wallet.faults.lose=true
  const result=await completeResolution(t.wallet,t.agreement,funded.send,signed,backup)
  expect((await verifyPayout(t.wallet,t.agreement,funded.send,signed,result.payouts)).verified).toBe(true)
  const claim=await prepareClaim(t.wallet,t.agreement,result.payouts.payer,t.keys.payer.secret)
  t.wallet.faults.lose=true
  const collected=await completeClaim(t.wallet,t.agreement,claim,t.keys.payer.secret,backup)
  expect(collected.keep.reduce((n,p)=>n+Number(p.amount),0)).toBe(600)
  expect(ids((await completeClaim(t.wallet,t.agreement,claim,t.keys.payer.secret,backup)).keep)).toEqual(ids(collected.keep))
})

it('recovers a lost legacy service-fee response without paying the fee twice',async()=>{
  const t=await testTrade(),wallet=testMint(t.agreement,{cache:false})
  const input=wallet.issue(OutputData.createRandomData(1020,wallet.getKeyset())),op=await prepareFee(wallet,t.agreement,input)
  wallet.faults.lose=true
  const fee=await completeFee(wallet,t.agreement,op,backup)
  expect(await verifyFeeProofs(wallet,t.agreement,fee.send)).toBe(true)
  expect(ids((await completeFee(wallet,t.agreement,op,backup)).send)).toEqual(ids(fee.send))
  const funded=await completeFunding(wallet,t.agreement,await prepareFunding(wallet,t.agreement,fee.keep),backup)
  expect((await verifyFunding(wallet,t.agreement,funded.send)).verified).toBe(true)
})

it('connects to a finite-cache mint only when its NUT-09 restoration is verified',async()=>{
  const {agreement}=await testTrade()
  const wallet=support=>({unit:'sat',loadMint:async()=>{},getMintInfo:()=>({isSupported:n=>n===19?{supported:true,params:{ttl:3600,cached_endpoints:[{method:'POST',path:'/v1/swap'}]}}:{supported:support.includes(n)}})})
  await expect(connectMint(agreement,{wallet:wallet([7,9,11,12])})).rejects.toThrow('not been verified')
  await expect(connectMint(agreement,{wallet:wallet([7,11,12]),restoreVerified:true})).rejects.toThrow('NUT-09 restore is unavailable')
  await expect(connectMint(agreement,{wallet:wallet([7,9,11]),restoreVerified:true})).rejects.toThrow('NUT-12')
  expect((await connectMint(agreement,{wallet:wallet([7,9,11,12]),restoreVerified:true})).unit).toBe('sat')
})
