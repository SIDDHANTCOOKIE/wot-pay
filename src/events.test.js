import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { offer, claim, settled, disputed, parse } from './events.js'
import { KIND } from './kinds.js'

const sk = generateSecretKey()
const pk = getPublicKey(sk)
const sign = (t) => finalizeEvent(t, sk)
const ID = 'a'.repeat(64)

describe('events', () => {
  it('round-trips an offer with mint and receive hints', () => {
    const ev = sign(
      offer({
        vpa: 'chai.stall@okaxis',
        payee: 'Chai Stall',
        inr: 250,
        sats: 3000,
        mint: 'https://mint.example.com/',
        receive: { method: 'lightning', address: 'maker@getalby.com' },
      }),
    )
    expect(ev.kind).toBe(KIND.OFFER)
    const o = parse(ev)
    expect(o).toMatchObject({
      type: 'offer',
      vpa: 'chai.stall@okaxis',
      inr: 250,
      sats: 3000,
      mint: 'https://mint.example.com',
      pubkey: pk,
    })
    expect(o.expiresAt).toBeGreaterThan(ev.created_at)
  })

  it('mint and receive are optional', () => {
    const o = parse(sign(offer({ vpa: 'a@upi', inr: '10.50', sats: 100 })))
    expect(o.mint).toBeUndefined()
    expect(o.receive).toBeUndefined()
    expect(o.inr).toBe(10.5)
  })

  it('links claim, settled and disputed to the offer', () => {
    const c = parse(
      sign(claim({ offerId: ID, maker: pk, receive: { method: 'cashu', mint: 'https://m.example' } })),
    )
    expect(c).toMatchObject({ type: 'claim', offerId: ID, maker: pk, receive: { method: 'cashu' } })
    const s = parse(sign(settled({ offerId: ID, claimId: 'b'.repeat(64), counterparty: pk })))
    expect(s).toMatchObject({ type: 'settled', offerId: ID, claimId: 'b'.repeat(64) })
    const d = parse(sign(disputed({ offerId: ID, counterparty: pk, reason: 'paid, no sats' })))
    expect(d).toMatchObject({ type: 'disputed', reason: 'paid, no sats' })
  })

  it('rejects bad input', () => {
    expect(() => offer({ vpa: 'not a vpa', inr: 1, sats: 1 })).toThrow()
    expect(() => offer({ vpa: 'a@upi', inr: 1, sats: 1.5 })).toThrow()
    expect(() => offer({ vpa: 'a@upi', inr: 1, sats: 1, mint: 'ftp://x' })).toThrow()
    expect(() => claim({ offerId: 'x', maker: pk })).toThrow()
    expect(() => disputed({ offerId: ID, counterparty: pk })).toThrow()
    expect(parse({ kind: 1, tags: [], content: '' })).toBeNull()
  })
})

describe('hostile signed input and paise', () => {
  const raw = (body, tags = [['t', 'wot-pay']]) =>
    sign({ kind: 3401, created_at: 1, tags, content: JSON.stringify({ v: 1, ...body }) })
  const good = { upi: { pa: 'a@upi', am: '0.29', pn: 'Shop' }, sats: 10 }
  it.each([0.29, 1.01, 19.99, 500000])('accepts valid paise amount %s', (inr) => {
    expect(parse(sign(offer({ vpa: 'a@upi', inr, sats: 10 }))).inr).toBe(inr)
  })
  it('rejects fractional paise', () => {
    expect(() => offer({ vpa: 'a@upi', inr: 0.291, sats: 10 })).toThrow()
    expect(parse(raw({ ...good, upi: { ...good.upi, am: '0.291' } }))).toBeNull()
  })
  it.each([
    { ...good, upi: { ...good.upi, pn: { bad: true } } },
    { ...good, mint: { bad: true } },
    { ...good, note: [] },
    { ...good, receive: { method: 'lightning', address: {} } },
    { ...good, receive: { method: 'other' } },
    { ...good, sats: Number.MAX_SAFE_INTEGER + 1 },
    { ...good, upi: { ...good.upi, pn: 'x'.repeat(257) } },
  ])('drops hostile field types/lengths', (body) => expect(parse(raw(body))).toBeNull())
  it('rejects oversized payload and broken tags without throwing', () => {
    expect(parse(raw({ ...good, note: 'x'.repeat(16000) }))).toBeNull()
    expect(parse({ ...raw(good), tags: [null] })).toBeNull()
    expect(
      parse(
        raw(good, [
          ['t', 'wot-pay'],
          ['expiration', 'nope'],
        ]),
      ),
    ).toBeNull()
  })
})

describe('signed claim release', () => {
  it('roundtrips deletion request without public token', async () => {
    const { cancelClaim } = await import('./events.js')
    const e = sign(cancelClaim({ offerId: ID, claimId: 'b'.repeat(64) }))
    expect(parse(e)).toMatchObject({ type: 'cancel', offerId: ID, claimId: 'b'.repeat(64) })
  })
})

it('rejects far-future events and accepts only bounded clock skew', () => {
  const t=offer({vpa:'a@ok',inr:10,sats:100}),now=Math.floor(Date.now()/1000)
  expect(parse(sign({...t,created_at:now+60}))).not.toBeNull()
  expect(parse(sign({...t,created_at:now+61}))).toBeNull()
  expect([sign(t),sign(t)].map(parse).filter(Boolean)).toHaveLength(2)
})

it('claims can carry an optional whole-sats bid and reject bad bids', () => {
  const c = claim({ offerId: ID, maker: pk, receive: { method: 'cashu' }, sats: 950 })
  expect(parse(sign(c)).sats).toBe(950)
  expect(parse(sign(claim({ offerId: ID, maker: pk }))).sats).toBeUndefined()
  for (const bad of [0, -5, 1.5, NaN]) expect(() => claim({ offerId: ID, maker: pk, sats: bad })).toThrow()
  const tampered = sign(claim({ offerId: ID, maker: pk, sats: 900 }))
  tampered.content = JSON.stringify({ v: 1, sats: 'lots' })
  expect(parse(tampered)).toBeNull()
})
