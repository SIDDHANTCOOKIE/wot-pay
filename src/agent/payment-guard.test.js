import { it, expect } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { offer, claim, acceptClaim, cancelClaim, parse } from '../events.js'
import { mayDeliverMessage } from './payment-guard.js'
const sk=generateSecretKey(),me=getPublicKey(sk),maker=generateSecretKey(),mp=getPublicKey(maker)
const sign=(t,key)=>finalizeEvent(t,key)
const o=parse(sign(offer({vpa:'test@ok',inr:100,sats:1000}),maker))
const c=sign(claim({offerId:o.id,maker:mp}),sk)
const acceptance=sign(acceptClaim({offerId:o.id,claimId:c.id,counterparty:me}),maker)
const item={messageScope:'current',requiresAcceptance:true,offerId:o.id,claimId:c.id}
const ctx=(fresh)=>({events:new Map([[o.id,o],[c.id,parse(c)]]),query:async()=>fresh,me})
it('drops unscoped legacy queued DMs',async()=>expect(await mayDeliverMessage({},ctx([]))).toBe(false))
it('does not send before acceptance and sends only the accepted exact claim',async()=>{
  expect(await mayDeliverMessage(item,ctx([]))).toBe(false)
  expect(await mayDeliverMessage(item,ctx([acceptance]))).toBe(true)
  expect(await mayDeliverMessage({...item,claimId:'wrong'},ctx([acceptance]))).toBe(false)
})
it('fresh cancellation invalidates queued payment instructions',async()=>{
  const release=sign(cancelClaim({offerId:o.id,claimId:c.id}),sk)
  expect(await mayDeliverMessage(item,ctx([acceptance,release]))).toBe(false)
})
it('query failure keeps instructions retryable rather than sending stale',async()=>{
  await expect(mayDeliverMessage(item,{...ctx([]),query:async()=>{throw Error('offline')}})).rejects.toThrow('offline')
})

it('empty relay response does not authorize a cached acceptance',async()=>{
 const context=ctx([]);context.events.set(acceptance.id,parse(acceptance))
 await expect(mayDeliverMessage(item,context)).rejects.toThrow('not verified')
})
