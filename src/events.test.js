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
    const c = parse(sign(claim({ offerId: ID, maker: pk, receive: { method: 'cashu', mint: 'https://m.example' } })))
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
