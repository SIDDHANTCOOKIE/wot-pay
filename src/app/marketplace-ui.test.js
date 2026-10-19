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
