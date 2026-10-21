import { expect, it, vi, onTestFinished } from 'vitest'
import { finalizeEvent } from 'nostr-tools/pure'
import { testTrade } from './fixtures.js'
import { listingTemplate, currentListings, validateAgreement, tradeView, viewOf, validateResolution, requireFreeSlot, payerCommitted, parsePrivate, contentHash, FUNDING_WINDOW, GRACE, TRADE_KIND, CONFIRM_WINDOW } from './protocol.js'

// Peers' messages dated in the future are ignored, so view trades from later.
function later(now) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime((now + 3000) * 1000)
  onTestFinished(() => vi.useRealTimers())
}
// Payer-built proposal: the proposal itself is the payer's signed commitment.
async function committed() {
  const t = await testTrade()
  const proposal = t.sign('payer', 'proposal', {})
  return { ...t, proposal, verified: { funding: { agreementId: t.id, verified: true, verifiedAt: t.now + 3 } } }
}

it('public listings reject payment details and pause replaces earlier availability', async () => {
  const { identities, now } = await testTrade()
  const listing = { v: 3, type: 'payer-listing', listingId: '3'.repeat(64), mint: 'https://mint.example', minPaise: 100, maxPaise: 50000, rateType: 'market', rate: '250', available: true, expiresAt: now + 3600 }
  expect(() => listingTemplate({ ...listing, vpa: 'private@upi' }, now)).toThrow()
  expect(() => listingTemplate({ ...listing, v: 2 }, now)).toThrow()
  const a = finalizeEvent(listingTemplate(listing, now), identities.payer.sk)
  const b = finalizeEvent(listingTemplate({ ...listing, available: false }, now + 1), identities.payer.sk)
  expect(currentListings([a], now + 2)).toHaveLength(1)
  expect(currentListings([b,a], now + 2)).toHaveLength(0)
})
it('locks exact amount and payee with independent keys and no platform-fee fields', async () => {
  const { agreement } = await testTrade()
  expect(validateAgreement(agreement)).toBe(agreement)
  for (const extra of [{ serviceFeeSats: 0 }, { feeRecipient: null }]) expect(() => validateAgreement({ ...agreement, ...extra })).toThrow('Unexpected')
  expect(() => validateAgreement({ ...agreement, v: 2 })).toThrow()
  expect(() => validateAgreement({ ...agreement, escrowKeys: { ...agreement.escrowKeys, payer: agreement.escrowKeys.requester } })).toThrow()
  expect(await contentHash({ ...agreement, destination: { vpa: 'other@upi' } })).not.toBe(await contentHash(agreement))
})
it('signs trade messages as a dedicated non-feed kind with optional signed references', async () => {
  const { sign } = await testTrade(), proposal = sign('payer','proposal',{})
  expect(proposal.kind).toBe(TRADE_KIND)
  expect(parsePrivate({ ...proposal, kind: 1 })).toBeNull()
  expect(() => sign('requester','funding',{ re: 'not-an-id' })).toThrow()
})
it('commits the payer by a payer-built proposal and the requester by a referencing funding notice', async () => {
  const { agreement, id, sign, now, proposal, verified } = await committed()
  const offered = tradeView(agreement,id,[proposal],{},now+2)
  expect([offered.offered,offered.canFund,offered.needsPayerAccept,offered.status]).toEqual([true,true,false,'awaiting-funding'])
  const stray = sign('requester','funding',{ re: '9'.repeat(64) },now+2)
  expect(tradeView(agreement,id,[proposal,stray],{},now+3).notice).toBeUndefined()
  const notice = sign('requester','funding',{ re: proposal.id },now+2)
  const sent = tradeView(agreement,id,[proposal,notice],{},now+3)
  expect([sent.status,sent.canFund,sent.canPay]).toEqual(['escrow-sent',false,false])
  expect(tradeView(agreement,id,[proposal,notice],verified,now+3).canPay).toBe(true)
  const cancel = sign('requester','cancel-request',{},now+3)
  expect(tradeView(agreement,id,[proposal,notice,cancel],verified,now+4).canPay).toBe(false)
})
it('requires a payer accept that references a requester-built proposal and ignores outsiders', async () => {
  const { agreement, id, sign, now } = await testTrade()
  const proposal = sign('requester','proposal',{})
  const waiting = tradeView(agreement,id,[proposal],{},now+2)
  expect([waiting.offered,waiting.needsPayerAccept,waiting.status,waiting.canFund]).toEqual([false,true,'awaiting-payer',false])
  for (const wrong of [sign('payer','accept',{ re: '9'.repeat(64) }), sign('outsider','accept',{ re: proposal.id }), sign('requester','accept',{ re: proposal.id })])
    expect(tradeView(agreement,id,[proposal,wrong],{},now+2).offered).toBe(false)
  const accept = sign('payer','accept',{ re: proposal.id },now+2)
  expect(tradeView(agreement,id,[proposal,accept],{},now+3).canFund).toBe(true)
})
it('judges deadlines on this device\'s arrival time, so backdated messages cannot beat them', async () => {
  const { agreement, id, sign, now, proposal, verified } = await committed()
  later(now)
  // The payer's commitment is dated in time but only reached the requester after expiry.
  expect(tradeView(agreement,id,[proposal],{},now+400,{ [proposal.id]: agreement.quoteExpiresAt + GRACE + 1 }).offered).toBe(false)
  expect(tradeView(agreement,id,[proposal],{},now+400,{ [proposal.id]: agreement.quoteExpiresAt + GRACE }).offered).toBe(true)
  const fundBy = proposal.created_at + FUNDING_WINDOW
  const backdated = sign('requester','funding',{ re: proposal.id },fundBy)
  const late = tradeView(agreement,id,[proposal,backdated],verified,now+900,{ [backdated.id]: fundBy + GRACE + 1 })
  expect([late.lateNotice,late.lateFunding,late.canPay,late.occupiesSlot,late.status]).toEqual([true,true,false,false,'late-funding-refund'])
  const onTime = tradeView(agreement,id,[proposal,backdated],verified,now+900,{ [backdated.id]: fundBy + GRACE })
  expect([onTime.lateFunding,onTime.canPay,onTime.occupiesSlot]).toEqual([false,true,true])
  const signedLate = sign('requester','funding',{ re: proposal.id },fundBy + GRACE + 1)
  expect(tradeView(agreement,id,[proposal,signedLate],verified,now+900).lateFunding).toBe(true)
})
it('converges on refund-only after a signed escrow decline and ignores unreferenced reports', async () => {
  const { agreement, id, sign, now, proposal, verified } = await committed()
  const notice = sign('requester','funding',{ re: proposal.id },now+2)
  const unlinked = sign('payer','payment-report',{ status: 'started' },now+3)
  expect(tradeView(agreement,id,[proposal,notice,unlinked],verified,now+4).paymentStarted).toBe(false)
  const decline = sign('payer','escrow-declined',{ re: notice.id },now+3)
  for (const evidence of [verified, {}]) expect(tradeView(agreement,id,[proposal,notice,decline],evidence,now+4).declined).toBe(true)
  const view = tradeView(agreement,id,[proposal,notice,decline],verified,now+4)
  expect([view.status,view.canPay,view.occupiesSlot]).toEqual(['late-funding-refund',false,false])
  expect(() => validateResolution(agreement,view,{requesterSats:0,payerSats:1000,mintFeeSats:0,reason:'release'},agreement.payer)).toThrow('refunded')
  expect(() => validateResolution(agreement,view,{requesterSats:500,payerSats:500,mintFeeSats:0,reason:'split'},agreement.requester)).toThrow('refunded')
  expect(validateResolution(agreement,view,{requesterSats:1000,payerSats:0,mintFeeSats:0,reason:'declined'},agreement.payer).requesterSats).toBe(1000)
})
it('keeps pending payments and disputes locked beyond deadlines and occupying the payer slot', async () => {
  const { agreement, id, sign, now, proposal, verified } = await committed()
  const notice = sign('requester','funding',{ re: proposal.id },now+2)
  const events = [proposal,notice,sign('payer','payment-report',{status:'pending',re:notice.id},now+3),sign('payer','dispute',{reason:'UPI pending'},now+4)]
  const view = tradeView(agreement,id,events,{funding:{...verified.funding,verifiedAt:now}},now+100000)
  expect(view.status).toBe('disputed')
  expect(view.occupiesSlot).toBe(true)
  expect(view.mayEscalate).toBe(true)
  expect(() => requireFreeSlot(agreement.payer,[{id,agreement,view}], 'other')).toThrow()
  expect(() => validateResolution(agreement,view,{requesterSats:501,payerSats:500,mintFeeSats:0,reason:'split'},agreement.arbitrator)).toThrow()
})
it('opens post-release cases without reversing settlement', async () => {
  const { agreement, id, sign, now, proposal } = await committed()
  const notice = sign('requester','funding',{ re: proposal.id },now+2)
  const view = tradeView(agreement,id,[proposal,notice,sign('payer','follow-up',{reason:'Later reversal'},now+3)],{funding:{agreementId:id,verified:true},redemption:{agreementId:id,verified:true}},now+4)
  expect(view.status).toBe('completed')
  expect(view.occupiesSlot).toBe(false)
  expect(view.followUps).toHaveLength(1)
})
it('holds the payer slot until on-time funding can no longer arrive', async () => {
  const { agreement, id, sign, now, proposal, verified } = await committed()
  later(now)
  const row = (events, evidence = {}, received = {}, payer = agreement.payer) => ({ id: `trade:${id}`, value: { kind: 'trade', agreement: { ...agreement, payer }, events, evidence, received } })
  const last = proposal.created_at + FUNDING_WINDOW + GRACE
  expect(payerCommitted(agreement.payer,[row([proposal])],'trade:other',last)).toBe(true)
  expect(payerCommitted(agreement.payer,[row([proposal])],'trade:other',last+1)).toBe(false)
  expect(payerCommitted(agreement.payer,[row([proposal])],`trade:${id}`,now)).toBe(false)
  expect(payerCommitted(agreement.payer,[{id:'listing:x',value:{kind:'listing'}}],'trade:other',now)).toBe(false)
  const notice = sign('requester','funding',{ re: proposal.id },now+2)
  // An on-time notice awaiting verification keeps the slot reserved past the window.
  expect(payerCommitted(agreement.payer,[row([proposal,notice])],'trade:other',last+1000)).toBe(true)
  expect(payerCommitted(agreement.payer,[row([proposal,notice],verified)],'trade:other',last+1000)).toBe(true)
  const decline = sign('payer','escrow-declined',{ re: notice.id },now+3)
  expect(payerCommitted(agreement.payer,[row([proposal,notice,decline],verified)],'trade:other',last+1000)).toBe(false)
  expect(viewOf(row([proposal,notice],verified),now+5).occupiesSlot).toBe(true)
})
it('exposes the refund date and asks an unconfirmed payer to dispute before it', async () => {
  const { agreement, id, sign, now, proposal, verified } = await committed()
  const notice = sign('requester','funding',{ re: proposal.id },now+2)
  const paid = sign('payer','payment-report',{ status: 'successful', re: notice.id },now+3)
  const events = [proposal,notice,paid]
  expect(tradeView(agreement,id,events,verified,now+4).disputeDue).toBe(false)
  const due = tradeView(agreement,id,events,verified,paid.created_at+CONFIRM_WINDOW)
  expect([due.disputeDue,due.refundable,due.refundAfter]).toEqual([true,false,agreement.refundAfter])
  expect(tradeView(agreement,id,[...events,sign('requester','merchant-confirmed',{},now+4)],verified,paid.created_at+CONFIRM_WINDOW).disputeDue).toBe(false)
  expect(tradeView(agreement,id,events,verified,agreement.refundAfter).refundable).toBe(true)
  expect(() => validateAgreement({ ...agreement, refundAfter: agreement.refundAfter - 1 })).toThrow('refund time')
})
