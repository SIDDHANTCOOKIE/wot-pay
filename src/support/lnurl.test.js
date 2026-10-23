import { expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { decodeInvoice, parseAddress, resolveAddress, requestInvoice, checkVerify, isZapReceipt, waitForPayment, sha256Hex, shortHash } from './lnurl.js'
import { SPEC, HASHED_DESCRIPTION, HASHED_DESCRIPTION_SHA256 } from './bolt11.vectors.js'
import { makeInvoice, fakeProvider, hex } from './invoice.fixture.js'

const sk = generateSecretKey(), donor = { pubkey: getPublicKey(sk), sign: async t => finalizeEvent(t, sk) }
const recipientKey = getPublicKey(generateSecretKey()), providerKey = getPublicKey(generateSecretKey())
const nowSec = () => Math.floor(Date.now() / 1000)
const hash = hex(crypto.getRandomValues(new Uint8Array(32)))

it('decodes the official BOLT-11 invoices to the amounts, hashes and expiry the spec states', async () => {
  const none = decodeInvoice(SPEC.noAmount)
  expect([none.msats, none.timestamp, none.paymentHash, none.description]).toEqual([null, 1496314658, '0001020304050607080900010203040506070809000102030405060708090102', 'Please consider supporting this project'])
  const coffee = decodeInvoice(SPEC.coffee)
  expect([coffee.msats, coffee.description, coffee.expiry]).toEqual([250_000_000n, '1 cup coffee', 60])
  const hashed = decodeInvoice(SPEC.hashed)
  expect([hashed.msats, hashed.descriptionHash]).toEqual([2_000_000_000n, HASHED_DESCRIPTION_SHA256])
  expect(await sha256Hex(HASHED_DESCRIPTION)).toBe(HASHED_DESCRIPTION_SHA256)
  const pico = decodeInvoice(SPEC.pico)
  expect([pico.msats, pico.expiry, pico.expiresAt]).toEqual([967_878_534n, 604800, 1572468703 + 604800])
  expect(decodeInvoice(SPEC.coffee.toUpperCase()).msats).toBe(250_000_000n)
})
it('rejects invoices that are corrupted, mixed case, testnet, truncated or without a payment hash', () => {
  const flip = SPEC.coffee.slice(0, 60) + (SPEC.coffee[60] === 'q' ? 'p' : 'q') + SPEC.coffee.slice(61)
  expect(() => decodeInvoice(flip)).toThrow('checksum')
  expect(() => decodeInvoice(SPEC.coffee.slice(0, 20) + SPEC.coffee.slice(20).toUpperCase())).toThrow('valid invoice')
  expect(() => decodeInvoice(makeInvoice({ msats: 1_000_000n, paymentHash: hash, network: 'tb' }))).toThrow('mainnet')
  expect(() => decodeInvoice(SPEC.coffee.slice(0, 40))).toThrow()
  expect(() => decodeInvoice('not an invoice')).toThrow()
  expect(() => decodeInvoice(5)).toThrow()
})

it('parses Lightning addresses strictly', () => {
  expect(parseAddress(' Tips@Pay.Example ')).toEqual({ user: 'tips', domain: 'pay.example' })
  for (const bad of ['', 'nope', 'a@b', 'a@localhost', '@pay.example', 'a b@pay.example', 'a@pay.example/x', 'http://a@pay.example']) expect(() => parseAddress(bad)).toThrow('Lightning address')
})
it('resolves an address over https without credentials or redirects and reads its limits', async () => {
  const p = await fakeProvider({ nostr: providerKey })
  const pay = await resolveAddress(p.address, p.fetcher)
  expect(pay).toMatchObject({ address: 'tips@pay.example', minSats: 1, maxSats: 5_000_000, commentAllowed: 140, allowsNostr: true, nostrPubkey: providerKey })
  expect(p.fetcher.options).toMatchObject({ credentials: 'omit', redirect: 'error' })
  expect((await resolveAddress(p.address, (await fakeProvider()).fetcher).catch(e => e.message))).toBeTruthy()
})
it('refuses a provider that is unsafe or malformed', async () => {
  const resolve = tamper => fakeProvider({ tamper }).then(p => resolveAddress(p.address, p.fetcher))
  await expect(resolve({ callback: 'http://pay.example/pay/tips' })).rejects.toThrow('cannot receive')
  await expect(resolve({ callback: 'https://user:pw@pay.example/pay/tips' })).rejects.toThrow('cannot receive')
  await expect(resolve({ lnurlp: { tag: 'withdrawRequest' } })).rejects.toThrow('cannot receive')
  await expect(resolve({ lnurlp: { minSendable: 5000, maxSendable: 1000 } })).rejects.toThrow('cannot receive')
  await expect(resolve({ lnurlp: { minSendable: 'lots' } })).rejects.toThrow('cannot receive')
  // A provider's message is shown as plain text with markup characters removed.
  await expect(resolve({ lnurlp: { status: 'ERROR', reason: 'Account <b>closed</b>' } })).rejects.toThrow('Account bclosed/b')
  const big = { fetcher: async () => new Response('x'.repeat(30_000)) }
  await expect(resolveAddress('a@pay.example', big.fetcher)).rejects.toThrow('large')
  await expect(resolveAddress('a@pay.example', async () => new Response('<html>', { status: 200 }))).rejects.toThrow('unreadable')
  // A provider without Nostr support is plain LNURL-pay, not an error.
  expect((await fakeProvider().then(p => resolveAddress(p.address, p.fetcher))).allowsNostr).toBe(false)
  // allowsNostr without a usable key is not trusted.
  expect((await resolve({ lnurlp: { allowsNostr: true, nostrPubkey: 'nope' } })).allowsNostr).toBe(false)
})

it('asks for exactly the chosen amount, within limits, with an optional note', async () => {
  const p = await fakeProvider({ min: 21_000, max: 100_000_000 }), pay = await resolveAddress(p.address, p.fetcher)
  const invoice = await requestInvoice(pay, { sats: 5000, comment: ' thanks ' }, { fetcher: p.fetcher })
  expect(p.calls.callback[0].get('amount')).toBe('5000000')
  expect(p.calls.callback[0].get('comment')).toBe('thanks')
  expect(p.calls.callback[0].has('nostr')).toBe(false)
  expect([invoice.sats, invoice.msats, invoice.paymentHash, invoice.verify]).toEqual([5000, 5_000_000n, p.paymentHash, `https://pay.example/verify/${p.paymentHash}`])
  await expect(requestInvoice(pay, { sats: 20 }, { fetcher: p.fetcher })).rejects.toThrow('between 21 and 100,000 sats')
  await expect(requestInvoice(pay, { sats: 100_001 }, { fetcher: p.fetcher })).rejects.toThrow('between')
  for (const bad of [0, -5, 1.5, NaN, '10']) await expect(requestInvoice(pay, { sats: bad }, { fetcher: p.fetcher })).rejects.toThrow('whole number')
  await expect(requestInvoice(pay, { sats: 5000, comment: 'x'.repeat(141) }, { fetcher: p.fetcher })).rejects.toThrow('under 140')
  const quiet = await fakeProvider({ comment: 0 })
  await requestInvoice(await resolveAddress(quiet.address, quiet.fetcher), { sats: 5000, comment: 'ignored' }, { fetcher: quiet.fetcher })
  expect(quiet.calls.callback[0].has('comment')).toBe(false)
})
it('never shows an invoice that does not match what was chosen', async () => {
  const ask = async (tamper, input = { sats: 1000 }) => { const p = await fakeProvider({ tamper }); return requestInvoice(await resolveAddress(p.address, p.fetcher), input, { fetcher: p.fetcher }) }
  await expect(ask({ msats: 999_000n })).rejects.toThrow('different amount')
  await expect(ask({ msats: 1_001_000n })).rejects.toThrow('different amount')
  await expect(ask({ timestamp: nowSec() - 7200 })).rejects.toThrow('expired')
  await expect(ask({ expiry: 10 })).rejects.toThrow('expired')
  await expect(ask({ descriptionHash: hash })).rejects.toThrow('description')
  await expect(ask({ verify: 'http://pay.example/v' })).rejects.toThrow('unsafe')
  await expect(ask({ body: { pr: 'lnbc1junk' } })).rejects.toThrow()
  await expect(ask({ body: { pr: undefined } })).rejects.toThrow()
  // A provider with no payment-check link is allowed; the person is then asked to confirm.
  expect((await ask({ body: { verify: undefined } })).verify).toBeNull()
})

it('sends a public zap request only to the provider, and checks the invoice commits to it', async () => {
  const p = await fakeProvider({ nostr: providerKey }), pay = await resolveAddress(p.address, p.fetcher)
  const zap = { signer: donor, recipient: recipientKey, relays: ['wss://relay.example'] }
  const invoice = await requestInvoice(pay, { sats: 2100, comment: 'gm', zap }, { fetcher: p.fetcher })
  const sent = JSON.parse(p.calls.callback[0].get('nostr'))
  expect([sent.kind, sent.pubkey, sent.content, sent.tags.find(t => t[0] === 'p')[1], sent.tags.find(t => t[0] === 'amount')[1], sent.tags.find(t => t[0] === 'relays').slice(1)]).toEqual([9734, donor.pubkey, 'gm', recipientKey, '2100000', ['wss://relay.example']])
  expect(invoice.zapJson).toBe(p.calls.callback[0].get('nostr'))
  const plain = await fakeProvider()
  await expect(requestInvoice(await resolveAddress(plain.address, plain.fetcher), { sats: 1000, zap }, { fetcher: plain.fetcher })).rejects.toThrow('does not support Nostr zaps')
  const wrong = await fakeProvider({ nostr: providerKey, tamper: { descriptionHash: hash } })
  await expect(requestInvoice(await resolveAddress(wrong.address, wrong.fetcher), { sats: 1000, zap }, { fetcher: wrong.fetcher })).rejects.toThrow('does not match the zap request')
})

it('confirms payment from the provider, trusting a preimage only when it hashes to the invoice', async () => {
  const p = await fakeProvider({ verifyAfter: 0 }), pay = await resolveAddress(p.address, p.fetcher)
  const invoice = await requestInvoice(pay, { sats: 1000 }, { fetcher: p.fetcher })
  expect(await checkVerify(invoice, p.fetcher)).toEqual({ settled: true, proof: 'preimage' })
  const lying = await fakeProvider({ verifyAfter: 0, tamper: { preimage: hex(crypto.getRandomValues(new Uint8Array(32))) } })
  expect(await checkVerify(await requestInvoice(await resolveAddress(lying.address, lying.fetcher), { sats: 1000 }, { fetcher: lying.fetcher }), lying.fetcher)).toEqual({ settled: true, proof: 'provider' })
  const unpaid = await fakeProvider({ verifyAfter: 99 })
  expect(await checkVerify(await requestInvoice(await resolveAddress(unpaid.address, unpaid.fetcher), { sats: 1000 }, { fetcher: unpaid.fetcher }), unpaid.fetcher)).toEqual({ settled: false })
})
it('waits for payment through provider errors, and stops at the invoice expiry or on abort', async () => {
  const instant = async () => {}
  const p = await fakeProvider({ verifyAfter: 3, tamper: { verifyError: 1 } }), pay = await resolveAddress(p.address, p.fetcher)
  const invoice = await requestInvoice(pay, { sats: 1000 }, { fetcher: p.fetcher })
  expect(await waitForPayment(invoice, { fetcher: p.fetcher, sleep: instant })).toEqual({ settled: true, proof: 'preimage' })
  expect(p.calls.verify).toBe(4)
  const never = await fakeProvider({ verifyAfter: 999 })
  const open = await requestInvoice(await resolveAddress(never.address, never.fetcher), { sats: 1000 }, { fetcher: never.fetcher })
  let clock = nowSec()
  expect(await waitForPayment(open, { fetcher: never.fetcher, now: () => clock, sleep: async () => { clock += 200 } })).toEqual({ settled: false, expired: true })
  const controller = new AbortController()
  const result = await waitForPayment(open, { fetcher: never.fetcher, signal: controller.signal, sleep: async () => controller.abort() })
  expect(result).toEqual({ settled: false, expired: false })
})
it('accepts a zap receipt only from the provider key that names this exact request and invoice', async () => {
  const p = await fakeProvider({ nostr: providerKey }), pay = await resolveAddress(p.address, p.fetcher)
  const invoice = await requestInvoice(pay, { sats: 1000, zap: { signer: donor, recipient: recipientKey, relays: ['wss://relay.example'] } }, { fetcher: p.fetcher })
  const receipt = (over = {}) => ({ kind: 9735, pubkey: providerKey, tags: [['bolt11', invoice.pr], ['description', invoice.zapJson]], ...over })
  expect(isZapReceipt(receipt(), invoice, pay)).toBe(true)
  expect(isZapReceipt(receipt({ pubkey: recipientKey }), invoice, pay)).toBe(false)
  expect(isZapReceipt(receipt({ kind: 1 }), invoice, pay)).toBe(false)
  expect(isZapReceipt(receipt({ tags: [['bolt11', 'lnbc1other'], ['description', invoice.zapJson]] }), invoice, pay)).toBe(false)
  expect(isZapReceipt(receipt({ tags: [['bolt11', invoice.pr], ['description', '{}']] }), invoice, pay)).toBe(false)
  expect(isZapReceipt(null, invoice, pay)).toBe(false)
  const noVerify = { ...invoice, verify: null }
  let looks = 0
  expect(await waitForPayment(noVerify, { findReceipt: async () => ++looks >= 2, sleep: async () => {} })).toEqual({ settled: true, proof: 'zap-receipt' })
  expect(shortHash(invoice.paymentHash)).toMatch(/^[0-9a-f]{8}…[0-9a-f]{6}$/)
})
