import { afterEach, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { npubEncode } from 'nostr-tools/nip19'
import { makeMount } from './hook-harness.fixture.js'
import { fakeProvider } from '../support/invoice.fixture.js'

const runtime = vi.hoisted(() => ({ current: null }))
vi.mock('react', () => ({
  useState: init => runtime.current.state(init),
  useRef: value => runtime.current.ref(value),
}))
const mount = makeMount(runtime)
const { useSupport, supportConfig, receiptText, PRESETS } = await import('./useSupport.js')

const sk = generateSecretKey(), signer = { pubkey: getPublicKey(sk), sign: async t => finalizeEvent(t, sk) }
const providerKey = getPublicKey(generateSecretKey()), recipient = getPublicKey(generateSecretKey())
const until = async (check, what) => { for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)) } throw new Error(`Timed out waiting for ${what}`) }
let mounted = []
afterEach(() => { mounted.forEach(m => m.unmount()); mounted = [] })
function support(provider, extra = {}) {
  const m = mount(useSupport, { address: provider.address, recipient, signer, client: { relays: ['wss://relay.example'] }, fetcher: provider.fetcher, interval: 5, ...extra })
  mounted.push(m)
  return m
}
const ready = async m => { await m.api().open(); await until(() => m.api().state.step === 'amount', 'amount step'); return m.api().state.pay }

it('shows the button only for a valid Lightning address, and reads the recipient key', () => {
  const npub = npubEncode(recipient)
  expect(supportConfig({ VITE_SUPPORT_LN_ADDRESS: ' Tips@Pay.Example ', VITE_SUPPORT_NPUB: npub })).toEqual({ address: 'tips@pay.example', recipient })
  expect(supportConfig({ VITE_SUPPORT_NPUB: npub }).address).toBeNull()
  for (const bad of ['', 'nope', 'a@b', 'a@pay.example/x']) expect(supportConfig({ VITE_SUPPORT_LN_ADDRESS: bad }).address).toBeNull()
  expect(supportConfig({ VITE_SUPPORT_LN_ADDRESS: 'a@pay.example', VITE_SUPPORT_NPUB: 'garbage' }).recipient).toBeNull()
  expect(supportConfig({ VITE_SUPPORT_LN_ADDRESS: 'a@pay.example' }).recipient).toMatch(/^[0-9a-f]{64}$/)
  expect(PRESETS).toEqual([1000, 5000, 21000])
})

it('contacts the provider only when opened, then offers the amount step with its limits', async () => {
  const p = await fakeProvider({ min: 1000, max: 50_000_000 }), m = support(p)
  expect([m.api().state.step, p.calls.lnurlp]).toEqual(['closed', 0])
  const pay = await ready(m)
  expect([pay.minSats, pay.maxSats, p.calls.lnurlp]).toEqual([1, 50_000, 1])
  m.api().close()
  expect(m.api().state.step).toBe('closed')
})
it('falls back to showing the address when the browser or provider cannot be reached', async () => {
  const blocked = { address: 'tips@pay.example', fetcher: async () => { throw new TypeError('Failed to fetch') } }
  const m = support(blocked)
  await m.api().open()
  await until(() => m.api().state.step === 'fallback', 'fallback')
  expect(m.api().state.error).toMatch(/could not reach the payment provider/)
  const refused = await fakeProvider({ tamper: { lnurlp: { status: 'ERROR', reason: 'Wallet offline' } } }), n = support(refused)
  await n.api().open()
  await until(() => n.api().state.step === 'fallback', 'provider error')
  expect(n.api().state.error).toBe('Wallet offline')
})

it('creates an invoice for the chosen amount and shows a receipt once the provider confirms payment', async () => {
  const p = await fakeProvider({ verifyAfter: 2 }), m = support(p), pay = await ready(m)
  const started = m.api().create(pay, { sats: 5000, comment: 'good luck', publicZap: false })
  await until(() => m.api().state.step === 'invoice', 'invoice')
  expect(m.api().state.invoice).toMatchObject({ sats: 5000, msats: 5_000_000n })
  expect(p.calls.callback[0].get('comment')).toBe('good luck')
  await started
  await until(() => m.api().state.step === 'paid', 'receipt')
  const { receipt } = m.api().state
  expect(receipt).toMatchObject({ sats: 5000, provider: 'tips@pay.example', paymentHash: p.paymentHash, proof: 'preimage', zap: false })
  expect(receiptText(receipt)).toMatch(/^wot-pay support receipt\n5,000 sats to tips@pay\.example\n.+\nPayment hash: [0-9a-f]{64}\nConfirmed with proof of payment$/)
})
it('keeps the amount step with a clear message when the amount or invoice is refused', async () => {
  const p = await fakeProvider({ min: 21_000 }), m = support(p), pay = await ready(m)
  await m.api().create(pay, { sats: 5, comment: '', publicZap: false })
  expect(m.api().state).toMatchObject({ step: 'amount', error: expect.stringMatching(/between 21 and 5,000,000 sats/) })
  const lying = await fakeProvider({ tamper: { msats: 1000n } }), n = support(lying), lyingPay = await ready(n)
  await n.api().create(lyingPay, { sats: 1000, comment: '', publicZap: false })
  expect(n.api().state).toMatchObject({ step: 'amount', error: expect.stringMatching(/different amount/) })
  expect(n.api().state.invoice).toBeUndefined()
})
it('lets the person confirm when the provider has no way to check, and labels the receipt unconfirmed', async () => {
  const p = await fakeProvider({ tamper: { body: { verify: undefined } } }), m = support(p), pay = await ready(m)
  void m.api().create(pay, { sats: 1000, comment: '', publicZap: false })
  await until(() => m.api().state.step === 'invoice', 'invoice')
  await new Promise(r => setTimeout(r, 30))
  expect(m.api().state.step).toBe('invoice')
  m.api().confirmPaid()
  expect(m.api().state.receipt).toMatchObject({ proof: 'unconfirmed', sats: 1000 })
  expect(receiptText(m.api().state.receipt)).toContain('Not confirmed')
})
it('sends a public zap only when chosen, and confirms it from a relay receipt when there is no check link', async () => {
  const p = await fakeProvider({ nostr: providerKey, tamper: { body: { verify: undefined } } })
  let polls = 0, seen
  const client = { relays: ['wss://relay.example'], query: async filter => {
    seen = filter
    if (++polls < 3) return []
    const pr = hold.invoice.pr, description = hold.invoice.zapJson
    return [{ kind: 9735, pubkey: providerKey, tags: [['bolt11', pr], ['description', description]] }]
  } }
  const hold = {}, m = support(p, { client }), pay = await ready(m)
  const plain = await fakeProvider({ nostr: providerKey }), n = support(plain), plainPay = await ready(n)
  await n.api().create(plainPay, { sats: 1000, comment: '', publicZap: false })
  expect(plain.calls.callback[0].has('nostr')).toBe(false)
  const run = m.api().create(pay, { sats: 2100, comment: 'gm', publicZap: true })
  await until(() => m.api().state.step === 'invoice', 'zap invoice')
  hold.invoice = m.api().state.invoice
  const sent = JSON.parse(p.calls.callback[0].get('nostr'))
  expect([sent.kind, sent.pubkey, sent.tags.find(t => t[0] === 'p')[1]]).toEqual([9734, signer.pubkey, recipient])
  await run
  await until(() => m.api().state.step === 'paid', 'zap receipt')
  expect(m.api().state.receipt).toMatchObject({ proof: 'zap-receipt', zap: true })
  expect(seen).toMatchObject({ kinds: [9735], '#p': [recipient] })
})
it('ends an unpaid invoice at its expiry and lets the person start again', async () => {
  const p = await fakeProvider({ verifyAfter: 999, tamper: { expiry: 31 } })
  const m = support(p, { interval: 5 }), pay = await ready(m)
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const run = m.api().create(pay, { sats: 1000, comment: '', publicZap: false })
    await until(() => m.api().state.step === 'invoice', 'invoice')
    vi.setSystemTime(Date.now() + 120_000)
    await run
  } finally { vi.useRealTimers() }
  expect(m.api().state.step).toBe('expired')
  m.api().again()
  expect(m.api().state.step).toBe('amount')
})
it('stops watching for payment when the sheet is closed', async () => {
  const p = await fakeProvider({ verifyAfter: 999 }), m = support(p), pay = await ready(m)
  void m.api().create(pay, { sats: 1000, comment: '', publicZap: false })
  await until(() => m.api().state.step === 'invoice', 'invoice')
  m.api().close()
  const checks = p.calls.verify
  await new Promise(r => setTimeout(r, 60))
  expect([m.api().state.step, p.calls.verify - checks <= 1]).toEqual(['closed', true])
})
