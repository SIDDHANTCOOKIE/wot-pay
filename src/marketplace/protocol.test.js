import { expect, it, vi, onTestFinished } from 'vitest'
import { finalizeEvent } from 'nostr-tools/pure'
import { testTrade } from './fixtures.js'
import { listingTemplate, currentListings, validateAgreement, tradeView, validateResolution, requireFreeSlot, payerCommitted, contentHash, FUNDING_WINDOW, FUNDING_GRACE } from './protocol.js'

it('public listings reject payment details and pause replaces earlier availability', async () => {
  const { identities, now } = await testTrade()
  const listing = { v: 2, type: 'payer-listing', listingId: '3'.repeat(64), mint: 'https://mint.example', minPaise: 100, maxPaise: 50000, rateType: 'market', rate: '250', available: true, expiresAt: now + 3600 }
  expect(() => listingTemplate({ ...listing, vpa: 'private@upi' }, now)).toThrow()
  const a = finalizeEvent(listingTemplate(listing, now), identities.payer.sk)
  const b = finalizeEvent(listingTemplate({ ...listing, available: false }, now + 1), identities.payer.sk)
  expect(currentListings([a], now + 2)).toHaveLength(1)
  expect(currentListings([b,a], now + 2)).toHaveLength(0)
})
it('requires independent escrow keys and locks exact amount, payee and fee terms', async () => {
  const { agreement } = await testTrade()
  expect(validateAgreement(agreement)).toBe(agreement)
  expect(() => validateAgreement({ ...agreement, serviceFeeSats: 0 })).toThrow()
  expect(() => validateAgreement({ ...agreement, escrowKeys: { ...agreement.escrowKeys, payer: agreement.escrowKeys.requester } })).toThrow()
  expect(await contentHash({ ...agreement, destination: { vpa: 'other@upi' } })).not.toBe(await contentHash(agreement))
})
it('requires both accepts, local verified funding, and no outstanding cancellation before payment', async () => {
  const { agreement, id, sign, now } = await testTrade()
  const events = [sign('requester', 'accept'), sign('payer', 'accept')]
  expect(tradeView(agreement,id,events,{},now+2).canPay).toBe(false)
  const funding = { funding: { agreementId: id, verified: true, verifiedAt: now+2 } }
  expect(tradeView(agreement,id,events,funding,now+3).canPay).toBe(true)
  const cancel = sign('requester','cancel-request')
  const state = tradeView(agreement,id,[...events,cancel],funding,now+3)
  expect(state.canPay).toBe(false)
  expect(state.funded).toBe(true)
  expect(state.completed).toBe(false)
})
it('keeps pending payments and disputes locked beyond deadlines and occupying the payer slot', async () => {
  const { agreement, id, sign, now } = await testTrade()
  const events = [sign('requester','accept'),sign('payer','accept'),sign('payer','payment-report',{status:'pending'}),sign('payer','dispute',{reason:'UPI pending'})]
  const view = tradeView(agreement,id,events,{funding:{agreementId:id,verified:true,verifiedAt:now}},now+100000)
  expect(view.status).toBe('disputed')
  expect(view.occupiesSlot).toBe(true)
  expect(view.mayEscalate).toBe(true)
  expect(() => requireFreeSlot(agreement.payer,[{id,agreement,view}], 'other')).toThrow()
  expect(() => validateResolution(agreement,view,{requesterSats:501,payerSats:500,mintFeeSats:0,reason:'split'},agreement.arbitrator)).toThrow()
})
it('ignores outsider accepts and opens post-release cases without reversing settlement', async () => {
  const { agreement,id,sign,now } = await testTrade()
  const accepted = [sign('requester','accept'),sign('payer','accept')]
  expect(tradeView(agreement,id,[sign('requester','accept'),sign('fee','accept')],{},now+2).accepted).toBe(false)
  const view = tradeView(agreement,id,[...accepted,sign('payer','follow-up',{reason:'Later reversal'})],{funding:{agreementId:id,verified:true},redemption:{agreementId:id,verified:true}},now+3)
  expect(view.status).toBe('completed')
  expect(view.occupiesSlot).toBe(false)
  expect(view.followUps).toHaveLength(1)
})
it('makes escrow funded after the window refund-only and releases the payer slot', async () => {
  const { agreement, id, sign, now } = await testTrade()
  // Peers' notices from the future are ignored, so view the trade from later.
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime((now + 1000) * 1000)
  onTestFinished(() => vi.useRealTimers())
  const accepted = [sign('requester','accept'),sign('payer','accept')], acceptedAt = now + 1
  const funding = { funding: { agreementId: id, verified: true, verifiedAt: acceptedAt + 200 } }
  const onTime = tradeView(agreement,id,[...accepted,sign('requester','funding',{},acceptedAt+FUNDING_WINDOW+FUNDING_GRACE)],funding,acceptedAt+200)
  expect([onTime.lateFunding,onTime.canPay,onTime.occupiesSlot]).toEqual([false,true,true])
  for (const [events,evidence] of [[[...accepted,sign('requester','funding',{},acceptedAt+FUNDING_WINDOW+FUNDING_GRACE+1)],funding],[accepted,{funding:{...funding.funding,late:true}}]]) {
    const view = tradeView(agreement,id,events,evidence,acceptedAt+400)
    expect([view.status,view.lateFunding,view.canPay,view.occupiesSlot]).toEqual(['late-funding-refund',true,false,false])
    expect(() => validateResolution(agreement,view,{requesterSats:0,payerSats:1000,mintFeeSats:0,reason:'release'},agreement.payer)).toThrow('refunded')
    expect(() => validateResolution(agreement,view,{requesterSats:500,payerSats:500,mintFeeSats:0,reason:'split'},agreement.requester)).toThrow('refunded')
    expect(validateResolution(agreement,view,{requesterSats:1000,payerSats:0,mintFeeSats:0,reason:'late funding'},agreement.payer).requesterSats).toBe(1000)
  }
})
it('holds the payer slot until on-time funding can no longer arrive', async () => {
  const { agreement, id, sign, now } = await testTrade()
  const row = (events, evidence = {}, payer = agreement.payer) => ({ id: `trade:${id}`, value: { kind: 'trade', agreement: { ...agreement, payer }, events, evidence } })
  const accepts = [sign('payer','accept')], last = agreement.quoteExpiresAt + FUNDING_WINDOW + FUNDING_GRACE
  expect(payerCommitted(agreement.payer,[row(accepts)],'trade:other',last)).toBe(true)
  expect(payerCommitted(agreement.payer,[row(accepts)],'trade:other',last+1)).toBe(false)
  expect(payerCommitted(agreement.payer,[row(accepts)],`trade:${id}`,now)).toBe(false)
  expect(payerCommitted(agreement.payer,[row(accepts,{},agreement.requester)],'trade:other',now)).toBe(false)
  const both = [sign('requester','accept'),...accepts], funding = { agreementId: id, verified: true, verifiedAt: now+2 }
  expect(payerCommitted(agreement.payer,[row(both,{funding})],'trade:other',last+1000)).toBe(true)
  expect(payerCommitted(agreement.payer,[row(both,{funding:{...funding,late:true}})],'trade:other',last+1000)).toBe(false)
  expect(payerCommitted(agreement.payer,[{id:'listing:x',value:{kind:'listing'}}],'trade:other',now)).toBe(false)
})
