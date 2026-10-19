import { expect, it } from 'vitest'
import { finalizeEvent } from 'nostr-tools/pure'
import { testTrade } from './fixtures.js'
import { listingTemplate, currentListings, validateAgreement, tradeView, validateResolution, requireFreeSlot, contentHash } from './protocol.js'

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
