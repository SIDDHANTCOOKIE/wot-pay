import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import SupportButton, { SupportSheet } from './SupportButton.jsx'
import { SPEC } from '../support/bolt11.vectors.js'

const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props))
const recipient = 'a'.repeat(64), signer = { pubkey: 'b'.repeat(64) }
const config = { address: 'tips@pay.example', recipient }
const pay = (over = {}) => ({ address: 'tips@pay.example', domain: 'pay.example', minSats: 1, maxSats: 5_000_000, commentAllowed: 140, allowsNostr: true, ...over })
const sheet = (state, extra = {}, who = signer) => render(SupportSheet, { support: { state, close() {}, create() {}, confirmPaid() {}, again() {}, open() {}, ...extra }, config, signer: who })
const invoice = { pr: SPEC.coffee, sats: 5000, expiresAt: Math.floor(Date.now() / 1000) + 600, paymentHash: '1'.repeat(64), verify: 'https://pay.example/v' }

it('shows a small button only when a Lightning address is configured, and no longer the old zap card', () => {
  expect(render(SupportButton, { signer, client: {}, config: { address: null, recipient: null } })).toBe('')
  const html = render(SupportButton, { signer, client: {}, config })
  expect(html).toContain('⚡ Support us')
  expect(html).toContain('class="support-btn"')
  expect(html).not.toMatch(/Enjoying wot-pay|Open our Nostr profile|nostr:npub/)
})
it('asks for an amount within the provider limits and says exactly what is shared', () => {
  const html = sheet({ step: 'amount', pay: pay({ minSats: 5000 }) })
  expect(html).toMatch(/role="dialog"[^>]*aria-modal="true"/)
  expect(html).not.toContain('>1,000<')
  expect(html).toContain('>5,000<')
  expect(html).toContain('Between 5,000 and 5,000,000 sats')
  expect(html).toContain('Create invoice for 5,000 sats')
  expect(html).toContain('Shared with pay.example: the amount. Nothing from your trades.')
  expect(html).toContain('wot-pay has no platform fee')
})
it('offers a note and a public zap only when the provider and identity allow them', () => {
  const full = sheet({ step: 'amount', pay: pay() })
  expect(full).toContain('Note (optional)')
  expect(full).toContain('Also zap publicly on Nostr')
  expect(sheet({ step: 'amount', pay: pay({ commentAllowed: 0 }) })).not.toContain('Note (optional)')
  expect(sheet({ step: 'amount', pay: pay({ allowsNostr: false }) })).not.toContain('zap publicly')
  expect(sheet({ step: 'amount', pay: pay() }, {}, null)).not.toContain('zap publicly')
})
it('falls back to the plain address when the provider cannot be reached', () => {
  const html = sheet({ step: 'fallback', error: 'Your browser could not reach the payment provider.' })
  expect(html).toContain('could not reach the payment provider')
  expect(html).toContain('tips@pay.example')
  expect(html).toContain('href="lightning:tips@pay.example"')
  expect(html).toContain('Copy address')
})
it('shows the invoice as a QR code and wallet link, and asks for confirmation only when it cannot watch', () => {
  const watching = sheet({ step: 'invoice', pay: pay(), invoice, watching: true })
  expect(watching).toContain('Pay 5,000 sats')
  expect(watching).toMatch(/<svg[^>]*role="img"[^>]*aria-label="Lightning invoice QR code"/)
  expect(watching).toContain(`href="lightning:${SPEC.coffee}"`)
  expect(watching).toContain('Waiting for your payment')
  expect(watching).not.toContain("I've paid")
  const manual = sheet({ step: 'invoice', pay: pay(), invoice: { ...invoice, verify: null }, watching: false })
  expect(manual).toContain("I&#x27;ve paid")
  expect(manual).toContain('cannot confirm payments')
})
it('draws even the longest real invoice as a scannable code built from shapes, never injected markup', () => {
  const html = sheet({ step: 'invoice', pay: pay(), invoice: { ...invoice, pr: SPEC.pico }, watching: true })
  const path = html.match(/<path d="([^"]+)"/)[1]
  expect(path.startsWith('M4 4h1v1h-1z')).toBe(true)
  expect((path.match(/M/g) || []).length).toBeGreaterThan(500)
  expect(html).toMatch(/viewBox="0 0 (\d+) \1"/)
  expect(html).not.toContain('dangerouslySetInnerHTML')
})
it('shows a receipt that says how the payment was confirmed, and an expired state', () => {
  const receipt = proof => ({ sats: 5000, at: 1800000000, provider: 'tips@pay.example', paymentHash: 'ab'.repeat(32), proof, zap: false })
  const proven = sheet({ step: 'paid', receipt: receipt('preimage') })
  expect(proven).toContain('Thank you')
  expect(proven).toContain('5,000 sats received')
  expect(proven).toContain('abababab…ababab')
  expect(proven).toContain('Confirmed with proof of payment')
  expect(proven).toContain('Copy receipt')
  expect(sheet({ step: 'paid', receipt: receipt('unconfirmed') })).toContain('Not confirmed: you told us you paid')
  expect(sheet({ step: 'paid', receipt: { ...receipt('zap-receipt'), zap: true } })).toContain('public Nostr zap')
  const expired = sheet({ step: 'expired', pay: pay() })
  expect(expired).toContain('That invoice expired. Nothing was charged.')
  expect(expired).toContain('Create a new invoice')
})
