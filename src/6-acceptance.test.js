import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { acceptClaim, claim, offer, parse } from './events.js'
import { tradeState } from './trade.js'
const key = () => {const sk=generateSecretKey();return {sk,pk:getPublicKey(sk)}}
const maker=key(), taker=key(), outsider=key()
const time=Math.floor(Date.now()/1000)
const sign=(template,who,at=time)=>parse(finalizeEvent({...template,created_at:at},who.sk))
const o=sign(offer({vpa:'test@ok',inr:100,sats:1000}),maker)
const a=sign(claim({offerId:o.id,maker:maker.pk}),taker)
const b=sign(claim({offerId:o.id,maker:maker.pk}),outsider)
const accept=(c,who=maker,at=time)=>sign(acceptClaim({offerId:o.id,claimId:c.id,counterparty:c.pubkey}),who,at)
describe('signed maker acceptance',()=>{
  it('roundtrips an exact claim binding and refuses missing claim ids',()=>{
    expect(accept(b)).toMatchObject({type:'accept',claimId:b.id,counterparty:outsider.pk})
    expect(()=>acceptClaim({offerId:o.id,counterparty:outsider.pk})).toThrow()
  })
  it('pending claims are reviewable but do not reserve the offer',()=>{
    const state=tradeState(o,[a,b])
    expect(state.claims).toHaveLength(2);expect(state.accepted).toBe(false);expect(state.status).toBe('open')
  })
  it('maker, taker, outsider and guest agree despite different graphs and arrival orders',()=>{
    const ok=accept(b)
    for(const graph of [new Set(),new Set([maker.pk,taker.pk]),new Set([outsider.pk])]){
      for(const events of [[a,b,ok],[ok,b,a]]){
        const s=tradeState(o,events,{trustedClaimers:graph})
        expect(s.accepted).toBe(true);expect(s.claim.id).toBe(b.id);expect(s.status).toBe('claimed')
      }
    }
  })
  it('ignores outsider, wrong identity, backdated and expired acceptance',()=>{
    for(const bad of [accept(a,outsider), {...accept(a),counterparty:outsider.pk},accept(a,maker,time-1)])
      expect(tradeState(o,[a,b,bad]).accepted).toBe(false)
    expect(tradeState({...o,expiresAt:time},[a,accept(a)]).accepted).toBe(false)
  })
  it('first signed acceptance wins, with lowest id for a same-second tie',()=>{
    const x=accept(a),y=accept(b)
    const winner=x.id<y.id?x:y
    expect(tradeState(o,[a,b,x,y]).acceptance.id).toBe(winner.id)
    expect(tradeState(o,[a,b,y,x]).acceptance.id).toBe(winner.id)
  })
  it('a valid claim cancellation removes its acceptance',()=>{
    const ok=accept(a),cancel={type:'cancel',pubkey:taker.pk,offerId:o.id,claimId:a.id,created_at:time}
    expect(tradeState(o,[a,b,ok,cancel]).accepted).toBe(false)
  })
})
