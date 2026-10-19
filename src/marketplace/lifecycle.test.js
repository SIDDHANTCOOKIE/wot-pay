import { expect, it } from 'vitest'
import { OutputData } from '@cashu/cashu-ts'
import { IDBFactory } from 'fake-indexeddb'
import { finalizeEvent } from 'nostr-tools/pure'
import { testMint } from './test-mint.fixture.js'
import { testTrade } from './fixtures.js'
import { prepareFee, completeFee, verifyFeeProofs } from './fees.js'
import { prepareFunding, completeFunding, prepareResolution, signResolution, completeResolution, verifyPayout, resolutionFingerprint, prepareClaim, completeClaim } from './escrow.js'
import { backupOperation, findRemoteSnapshots } from './backup.js'
import { createVault } from './vault.js'
import { encryptBackup, decryptBackup, newRecoverySecret } from '../recovery.js'
import { contentHash, tradeView, parsePrivate } from './protocol.js'

async function recovery(fixture) {
  const secret=newRecoverySecret(),identity=fixture.identities.requester
  const signer={pubkey:identity.pubkey,sign:async t=>finalizeEvent(t,identity.sk),sealLocal:async v=>new TextDecoder().decode(await encryptBackup(v,secret)),openLocal:s=>decryptBackup(new TextEncoder().encode(s),secret)}
  const vault=createVault(signer,new IDBFactory()),blobs=new Map(),events=new Map()
  const servers=['https://a.example','https://b.example','https://c.example']
  await vault.write('recovery-config',{secret,servers,savedOffline:true})
  const fetcher=async(url,options={})=>{
    const host=new URL(url).origin
    if(host===servers[2])return new Response('',{status:503})
    if(options.method==='PUT'){blobs.set(`${host}/${options.headers['X-SHA-256']}`,options.body);return new Response('')}
    return blobs.has(url)?new Response(blobs.get(url)):new Response('',{status:404})
  }
  const client={relays:['wss://a.example','wss://b.example'],publishTo:async(urls,event)=>events.set(event.id,event),queryOn:async(urls,filter)=>[events.get(filter.ids[0])].filter(Boolean),queryIdentity:async()=>[...events.values()]}
  return {vault,signer,secret,fetcher,client,blobs,backup:op=>backupOperation(vault,signer,op,fetcher,client)}
}

it('runs accepted quote → fee → escrow → release → recipient claim with replicated recovery and exact retry',async()=>{
  const t=await testTrade(),wallet=testMint(t.agreement),r=await recovery(t)
  const events=[t.sign('requester','accept'),t.sign('payer','accept')]
  expect(tradeView(t.agreement,t.id,events).canFund).toBe(true)
  const input=wallet.issue(OutputData.createRandomData(1020,wallet.getKeyset()))
  const feeOp=await prepareFee(wallet,t.agreement,input)
  await r.vault.write('fee-operation',feeOp)
  const fee=await completeFee(wallet,t.agreement,feeOp,r.backup)
  expect(await verifyFeeProofs(wallet,t.agreement,fee.send)).toBe(true)
  await expect(verifyFeeProofs(wallet,{...t.agreement,nonce:'3'.repeat(64)},fee.send)).rejects.toThrow('agreement')
  expect(await completeFee(wallet,t.agreement,feeOp,r.backup)).toEqual(fee)
  const fundingOp=await prepareFunding(wallet,t.agreement,fee.keep)
  await r.vault.write('funding-operation',fundingOp)
  const funded=await completeFunding(wallet,t.agreement,fundingOp,r.backup)
  expect(parsePrivate(t.sign('requester','funding',{proofs:funded.send,feeProofs:fee.send})).payload.proofs).toEqual(funded.send)
  expect(tradeView(t.agreement,t.id,events,{funding:funded.funding}).canPay).toBe(true)
  const op=await prepareResolution(wallet,t.agreement,funded.send,{requesterSats:0,payerSats:1000,mintFeeSats:0,reason:'merchant confirmed'})
  const fingerprint=await resolutionFingerprint(t.agreement,funded.send,op)
  const one=await signResolution(t.agreement,funded.send,op,t.keys.requester.secret)
  expect(await resolutionFingerprint(t.agreement,funded.send,one)).toBe(fingerprint)
  const two=await signResolution(t.agreement,funded.send,one,t.keys.payer.secret)
  const result=await completeResolution(wallet,t.agreement,funded.send,two,r.backup)
  const receipt=await verifyPayout(wallet,t.agreement,funded.send,two,result.payouts)
  expect(tradeView(t.agreement,t.id,events,{funding:funded.funding,redemption:receipt}).completed).toBe(true)
  const claim=await prepareClaim(wallet,t.agreement,result.payouts.payer,t.keys.payer.secret)
  const collected=await completeClaim(wallet,t.agreement,claim,t.keys.payer.secret,r.backup)
  expect(collected.keep.reduce((n,p)=>n+Number(p.amount),0)).toBe(1000)
  expect(await completeClaim(wallet,t.agreement,claim,t.keys.payer.secret,r.backup)).toEqual(collected)
  const restored=await findRemoteSnapshots(r.client,r.signer,r.secret,r.fetcher)
  expect(restored.operation.kind).toBe('claim')
  expect(restored.records.find(row=>row.id==='funding-operation').value).toEqual(fundingOp)
})

it('refuses stale, wrong-operation and same-host backup acknowledgements before consuming fee inputs',async()=>{
  const t=await testTrade(),wallet=testMint(t.agreement)
  const input=wallet.issue(OutputData.createRandomData(1020,wallet.getKeyset())),op=await prepareFee(wallet,t.agreement,input)
  const valid={operationHash:await contentHash(op),verifiedCopies:2,checkedAt:Date.now(),results:[{server:'https://a.example',verified:true},{server:'https://b.example',verified:true}]}
  for(const bad of [{...valid,operationHash:'0'.repeat(64)},{...valid,checkedAt:Date.now()-61000},{...valid,results:[valid.results[0],valid.results[0]]}])await expect(completeFee(wallet,t.agreement,op,async()=>bad)).rejects.toThrow('backups')
  expect((await wallet.checkProofsStates(input)).every(p=>p.state==='UNSPENT')).toBe(true)
})

it('requires two discoverable backup pointers, and recovers a snapshot with one Blossom host down',async()=>{
  const t=await testTrade(),r=await recovery(t),op={kind:'funding',revision:'test'}
  await r.vault.write('trade:test',{secret:'escrow recovery key'})
  const receipt=await r.backup(op)
  expect(receipt.verifiedCopies).toBe(2)
  const restored=await findRemoteSnapshots(r.client,r.signer,r.secret,r.fetcher)
  expect(restored.records.find(r=>r.id==='trade:test').value.secret).toBe('escrow recovery key')
  r.client.queryOn=async()=>[]
  await expect(r.backup(op)).rejects.toThrow('index relays')
})

it('rejects an arbitrator-imposed split and detects a different payout using the same revision',async()=>{
  const t=await testTrade(),wallet=testMint(t.agreement),r=await recovery(t)
  const input=wallet.issue(OutputData.createRandomData(1000,wallet.getKeyset()))
  const funded=await completeFunding(wallet,t.agreement,await prepareFunding(wallet,t.agreement,input),r.backup)
  const allocation={requesterSats:400,payerSats:600,mintFeeSats:0,reason:'mutual split'}
  const op=await prepareResolution(wallet,t.agreement,funded.send,allocation)
  const changed={...await prepareResolution(wallet,t.agreement,funded.send,allocation),revision:op.revision}
  expect(await resolutionFingerprint(t.agreement,funded.send,changed)).not.toBe(await resolutionFingerprint(t.agreement,funded.send,op))
  const one=await signResolution(t.agreement,funded.send,op,t.keys.requester.secret)
  const two=await signResolution(t.agreement,funded.send,one,t.keys.arbitrator.secret)
  await expect(completeResolution(wallet,t.agreement,funded.send,two,r.backup)).rejects.toThrow('both participants')
})
