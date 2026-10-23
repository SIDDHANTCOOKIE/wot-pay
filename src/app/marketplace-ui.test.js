import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import BoardScreen from './BoardScreen.jsx'
import QuotePreview from './QuotePreview.jsx'
import ExampleOffer from './ExampleOffer.jsx'
import PayScreen from './PayScreen.jsx'

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null })
  vi.stubGlobal('location', { hash: '', origin: 'https://example.test', pathname: '/' })
})
afterEach(() => vi.unstubAllGlobals())
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props))
const maker = 'a'.repeat(64), payer = 'b'.repeat(64), other = 'c'.repeat(64)
const offer = { type: 'offer', id: 'd'.repeat(64), pubkey: maker, vpa: 'example@upi', inr: 500, sats: 1000, created_at: 1 }
const claim = { type: 'claim', id: 'e'.repeat(64), offerId: offer.id, maker, pubkey: payer, sats: 1200, created_at: 2, receive: { method: 'cashu' } }
const acceptance = { type: 'accept', id: 'f'.repeat(64), offerId: offer.id, pubkey: maker, claimId: claim.id, counterparty: payer, created_at: 3 }
const board = events => ({ events: [offer, claim, acceptance, ...events], ranker: { explain: () => ({ hops: 1, score: 1, settles: 0, disputes: 0 }), rank: a => a }, profiles: {}, cash: { supported: true, forOffer: () => [] } })

it('blocks legacy UPI instructions for conflicting acceptances', () => {
  const second = { ...claim, id: '1'.repeat(64), pubkey: other }
  const conflict = { ...acceptance, id: '2'.repeat(64), claimId: second.id, counterparty: other }
  const html = render(BoardScreen, { board: board([second, conflict]), signer: { pubkey: payer }, initialOfferId: offer.id })
  expect(html).toContain('Conflicting payer acceptances')
  expect(html).not.toContain('href="upi:')
})
it('checks received tokens against the accepted bid, not the original ask', () => {
  const b = board([])
  b.cash.forOffer = () => [{ id: 'token', amount: 1000, unit: 'sat', mint: 'https://mint.example', token: 'cashuBexample' }]
  const html = render(BoardScreen, { board: b, signer: { pubkey: payer }, initialOfferId: offer.id })
  expect(html).toContain('1,200 sats')
  expect(html).toContain('200 sats short')
})
it('does not render another identity’s requester controls from a saved active id', () => {
  const html = render(PayScreen, { board: board([]), signer: { pubkey: other }, activeId: offer.id })
  expect(html).toContain('Scan a UPI QR')
  expect(html).toContain('Scan with camera')
  expect(html).not.toContain('<video')
  expect(html).not.toContain('I sent the sats')
})
it('keeps new QR details in a disabled preview with no publishing or payment link', () => {
  const html = render(QuotePreview, { draft: { vpa: 'example@upi', inr: 500 } })
  expect(html).toContain('Protected trades are being prepared')
  expect(html).toContain('disabled')
  expect(html).not.toContain('href="upi:')
  expect(html).not.toContain('Post for')
})
it('keeps the example non-interactive and honors dismissal', () => {
  expect(render(ExampleOffer, {})).toContain('Example · not a live offer')
  vi.stubGlobal('localStorage', { getItem: () => '1' })
  expect(render(ExampleOffer, {})).not.toContain('Simulated example offer')
  expect(render(ExampleOffer, {})).toContain('Show example offer')
})
it('shows the payer a dispute prompt and the requester a solo refund once their deadlines pass', async () => {
  const { testTrade } = await import('../marketplace/fixtures.js')
  const { tradeView, CONFIRM_WINDOW } = await import('../marketplace/protocol.js')
  const { default: ProtectedTrades } = await import('./ProtectedTrades.jsx')
  const t = await testTrade(), proposal = t.sign('payer','proposal',{}), notice = t.sign('requester','funding',{re:proposal.id},t.now+2)
  const paid = t.sign('payer','payment-report',{status:'successful',re:notice.id},t.now+3)
  const evidence = { funding: { agreementId: t.id, verified: true, verifiedAt: t.now+2 } }
  const page = (pubkey, now) => {
    const row = { id: `trade:${t.id}`, value: { agreement: t.agreement, events: [proposal,notice,paid], evidence } }
    return render(ProtectedTrades, { signer: { pubkey }, market: { records: [], trades: [{ ...row, view: tradeView(t.agreement,t.id,row.value.events,evidence,now) }], config: { protectedEnabled: true } } })
  }
  expect(page(t.agreement.payer, paid.created_at+CONFIRM_WINDOW)).toContain('has not confirmed your payment for 24 hours')
  expect(page(t.agreement.payer, t.now+10)).not.toContain('has not confirmed your payment')
  expect(page(t.agreement.requester, t.agreement.refundAfter)).toContain('Refund escrow to me')
  expect(page(t.agreement.requester, t.agreement.refundAfter-1)).not.toContain('Refund escrow to me')
})
it('shows the mint-issued invoice only while the funding window is open, and the escrow trust panel', async () => {
  const { testTrade } = await import('../marketplace/fixtures.js')
  const { tradeView } = await import('../marketplace/protocol.js')
  const { default: ProtectedTrades } = await import('./ProtectedTrades.jsx')
  const t = await testTrade(), proposal = t.sign('payer','proposal',{})
  const page = (value, evidence = {}) => {
    const row = { id: `trade:${t.id}`, value: { agreement: t.agreement, events: [proposal], evidence, ...value } }
    return render(ProtectedTrades, { signer: { pubkey: t.agreement.requester }, market: { records: [], trades: [{ ...row, view: tradeView(t.agreement,t.id,row.value.events,evidence) }], config: { protectedEnabled: true } } })
  }
  expect(page({})).toContain('Accept &amp; fund with Lightning')
  const pending = { lightningReady: true, lightningOperation: { invoice: 'lnbc1000test' } }
  expect(page(pending)).toContain('href="lightning:lnbc1000test"')
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime((proposal.created_at + 601) * 1000)
  try {
    expect(page(pending)).toContain('Do not pay this invoice now')
    expect(page(pending)).not.toContain('href="lightning:')
  } finally { vi.useRealTimers() }
  const funded = page({ proofs: [{ amount: 1000 }] }, { funding: { agreementId: t.id, verified: true } })
  expect(funded).toContain('Where are my sats?')
  expect(funded).toContain('wot-pay never holds your money')
})
it('gives each side one primary action at the payment step', async () => {
  const { testTrade } = await import('../marketplace/fixtures.js')
  const { tradeView } = await import('../marketplace/protocol.js')
  const { default: ProtectedTrades } = await import('./ProtectedTrades.jsx')
  const t = await testTrade(), proposal = t.sign('payer','proposal',{}), notice = t.sign('requester','funding',{re:proposal.id},t.now+2)
  const started = t.sign('payer','payment-report',{status:'started',re:notice.id},t.now+3)
  const release = t.sign('payer','resolution-approve',{operation:{allocation:{requesterSats:0,payerSats:1000,mintFeeSats:0}}},t.now+4)
  const evidence = { funding: { agreementId: t.id, verified: true } }
  const page = (pubkey, events) => render(ProtectedTrades, { signer: { pubkey }, market: { records: [], trades: [{ id: `trade:${t.id}`, value: { agreement: t.agreement, events, evidence }, view: tradeView(t.agreement,t.id,events,evidence) }], config: { protectedEnabled: true } } })
  expect(page(t.agreement.payer,[proposal,notice,started])).toContain('I paid · request release')
  expect(page(t.agreement.payer,[proposal,notice,started,release])).not.toContain('I paid · request release')
  expect(page(t.agreement.requester,[proposal,notice,started])).not.toContain('Merchant received it')
  expect(page(t.agreement.requester,[proposal,notice,started,release])).toContain('Merchant received it · release payment')
})
it('offers a visible switch for Nostr notices, on by default', async () => {
  const { default: SigningSettings } = await import('./SigningSettings.jsx')
  const html = render(SigningSettings, { signer: { pubkey: 'a'.repeat(64) }, onSigner() {}, onSignOut() {} })
  expect(html).toContain('Send Nostr notices')
  expect(html).toMatch(/type="checkbox"[^>]*checked/)
  expect(html).toContain('never includes payment details')
  vi.stubGlobal('localStorage', { getItem: k => (k === 'wot-pay:nostr-notices' ? 'off' : null) })
  expect(render(SigningSettings, { signer: { pubkey: 'a'.repeat(64) }, onSigner() {}, onSignOut() {} })).not.toMatch(/type="checkbox"[^>]*checked/)
})
