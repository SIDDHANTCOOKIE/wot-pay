import { expect, it } from 'vitest'
import { OutputData } from '@cashu/cashu-ts'
import { testTrade } from './fixtures.js'
import { testMint } from './test-mint.fixture.js'
import { contentHash } from './protocol.js'
import { prepareLightningFunding, completeLightningFunding, verifyFunding, deserializeMint, validateLockedProofs } from './escrow.js'

const backup=async operation=>({operationHash:await contentHash(operation),verifiedCopies:2,checkedAt:Date.now(),results:[{server:'https://one.example',verified:true},{server:'https://two.example',verified:true}]})
async function prepared(options) {
  const t=await testTrade(),wallet=testMint(t.agreement,options)
  // Persisted and restored as JSON, exactly as the vault and backups hold it.
  const operation=JSON.parse(JSON.stringify(await prepareLightningFunding(wallet,t.agreement,t.keys.requester)))
  return {...t,wallet,operation,quote:operation.preview.quote.quote}
}

it('asks the mint for a quote locked to the requester key and pre-locks every output to the escrow',async()=>{
  const t=await prepared()
  expect(t.operation.invoice).toMatch(/^lnbc/)
  expect(t.operation.preview.quote.pubkey).toBe(t.keys.requester.pubkey)
  const outputs=deserializeMint(t.operation.preview).outputData
  expect(outputs.reduce((n,o)=>n+Number(o.blindedMessage.amount),0)).toBe(t.agreement.escrowSats)
  expect(()=>validateLockedProofs(t.agreement,outputs.map(o=>({secret:new TextDecoder().decode(o.secret),amount:o.blindedMessage.amount})))).not.toThrow()
})
it('waits for payment, then mints verified escrow exactly once',async()=>{
  const t=await prepared()
  expect(await completeLightningFunding(t.wallet,t.agreement,t.operation,async()=>{throw new Error('no backup needed while unpaid')})).toBeNull()
  t.wallet.payInvoice(t.quote)
  const funded=await completeLightningFunding(t.wallet,t.agreement,t.operation,backup)
  expect(funded.funding.verified).toBe(true)
  expect((await verifyFunding(t.wallet,t.agreement,funded.send)).verified).toBe(true)
  // The quote is issued; a retry restores the same proofs instead of minting twice.
  const again=await completeLightningFunding(t.wallet,t.agreement,t.operation,backup)
  expect(again.send.map(p=>p.secret)).toEqual(funded.send.map(p=>p.secret))
})
it('restores the saved outputs after a lost response and retries an undelivered request',async()=>{
  const lost=await prepared()
  lost.wallet.payInvoice(lost.quote);lost.wallet.faults.lose=true
  const restored=await completeLightningFunding(lost.wallet,lost.agreement,lost.operation,backup)
  expect([restored.funding.verified,lost.wallet.faults.restoreCalls]).toEqual([true,1])
  const undelivered=await prepared()
  undelivered.wallet.payInvoice(undelivered.quote);undelivered.wallet.faults.fail=true
  await expect(completeLightningFunding(undelivered.wallet,undelivered.agreement,undelivered.operation,backup)).rejects.toThrow('not delivered')
  expect((await completeLightningFunding(undelivered.wallet,undelivered.agreement,undelivered.operation,backup)).funding.verified).toBe(true)
})
it('requires a durable backup and the quote-key signature before minting',async()=>{
  const t=await prepared()
  t.wallet.payInvoice(t.quote)
  await expect(completeLightningFunding(t.wallet,t.agreement,t.operation,async()=>{throw new Error('backup unavailable')})).rejects.toThrow('backup unavailable')
  const forged=structuredClone(t.operation);forged.preview.signature='00'.repeat(64)
  await expect(completeLightningFunding(t.wallet,t.agreement,forged,backup)).rejects.toThrow()
  expect((await t.wallet.checkMintQuoteBolt11(t.quote)).state).toBe('PAID')
  expect((await completeLightningFunding(t.wallet,t.agreement,t.operation,backup)).funding.verified).toBe(true)
})
it('refuses swapped outputs, a quote for other terms, and mints without NUT-20',async()=>{
  const t=await prepared()
  const swapped=structuredClone(t.operation)
  swapped.preview.outputData=OutputData.createRandomData(t.agreement.escrowSats,t.wallet.getKeyset()).map(o=>OutputData.serialize(o))
  t.wallet.payInvoice(t.quote)
  await expect(completeLightningFunding(t.wallet,t.agreement,swapped,backup)).rejects.toThrow()
  const short=testMint(t.agreement),create=short.createLockedMintQuote
  short.createLockedMintQuote=(amount,pubkey)=>create(amount-1,pubkey)
  await expect(prepareLightningFunding(short,t.agreement,t.keys.requester)).rejects.toThrow('different terms')
  const old=testMint(t.agreement);old.faults.unsupported=[20]
  await expect(prepareLightningFunding(old,t.agreement,t.keys.requester)).rejects.toThrow('NUT-20')
})
