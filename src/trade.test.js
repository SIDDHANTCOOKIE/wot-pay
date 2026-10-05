import { describe, it, expect } from 'vitest'
import { tradeState } from './trade.js'

const M = 'm'.repeat(64)
const T = 't'.repeat(64)
const U = 'u'.repeat(64)
const offer = { type: 'offer', id: 'o', pubkey: M, created_at: 1 }
const claim = (id, pubkey, created_at) => ({ type: 'claim', id, pubkey, offerId: 'o', maker: M, created_at })
const stamp = (type, pubkey, claimId, created_at) => ({
  type,
  pubkey,
  offerId: 'o',
  claimId,
  created_at,
  counterparty: pubkey === M ? (claimId === 'c2' ? U : T) : M,
})

describe('tradeState', () => {
  it('walks open -> claimed -> settled', () => {
    expect(tradeState(offer, []).status).toBe('open')
    const c = claim('c1', T, 2)
    expect(tradeState(offer, [c]).status).toBe('claimed')
    expect(tradeState(offer, [c, stamp('settled', M, 'c1', 3)]).status).toBe('stamped')
    expect(tradeState(offer, [c, stamp('settled', M, 'c1', 3), stamp('settled', T, 'c1', 4)]).status).toBe(
      'settled',
    )
  })

  it('either side can dispute', () => {
    const c = claim('c1', T, 2)
    expect(tradeState(offer, [c, stamp('settled', M, 'c1', 3), stamp('disputed', T, 'c1', 4)]).status).toBe(
      'disputed',
    )
  })

  it('first claim leads until the maker picks another', () => {
    const evs = [claim('c1', T, 2), claim('c2', U, 3)]
    expect(tradeState(offer, evs).claim.id).toBe('c1')
    expect(tradeState(offer, [...evs, stamp('settled', M, 'c2', 4)]).claim.id).toBe('c2')
  })

  it('ignores the maker claiming their own offer and stamps from strangers', () => {
    const evs = [claim('self', M, 2), claim('c1', T, 3), stamp('settled', U, 'c1', 4)]
    const s = tradeState(offer, evs)
    expect(s.claim.id).toBe('c1')
    expect(s.status).toBe('claimed')
  })
})

describe('stamp identity binding', () => {
  const c = claim('c1', T, 2)
  it('does not settle with taker stamp for a different claim', () => {
    expect(tradeState(offer, [c, stamp('settled', M, 'c1', 3), stamp('settled', T, 'wrong', 4)]).status).toBe(
      'stamped',
    )
  })
  it('ignores a stamp naming the wrong counterparty', () => {
    expect(tradeState(offer, [c, { ...stamp('settled', M, 'c1', 3), counterparty: U }]).status).toBe(
      'claimed',
    )
    expect(
      tradeState(offer, [
        c,
        stamp('settled', M, 'c1', 3),
        { ...stamp('settled', T, 'c1', 4), counterparty: U },
      ]).status,
    ).toBe('stamped')
  })
  it('does not accept a maker stamp with no claim', () => {
    expect(tradeState(offer, [stamp('settled', M, undefined, 3)]).status).toBe('open')
  })
})

describe('claim timing', () => {
  it('drops backdated claims from before the offer', () =>
    expect(tradeState({ ...offer, created_at: 10 }, [claim('early', T, 9)]).claim).toBeNull())
  it('same second race has one deterministic winner in either arrival order', () => {
    const a = claim('aaa', T, 2),
      b = claim('bbb', U, 2)
    expect(tradeState(offer, [b, a]).claim.id).toBe('aaa')
    expect(tradeState(offer, [a, b]).claim.id).toBe('aaa')
  })
})

describe('claim release', () => {
  it('only claim author can release it and next claim leads', () => {
    const a = claim('a', T, 2),
      b = claim('b', U, 3),
      release = { type: 'cancel', offerId: 'o', claimId: 'a', pubkey: T, created_at: 4 }
    expect(tradeState(offer, [a, b, release]).claim.id).toBe('b')
    expect(tradeState(offer, [a, b, { ...release, pubkey: U }]).claim.id).toBe('a')
  })
})

describe('viewer graph claim admission', () => {
  const policy = { trustedClaimers: new Set([M, T]) }
  it('outsider claim and dispute cannot remove an offer from open state', () => {
    const c = claim('c2', U, 2)
    expect(tradeState(offer, [c, stamp('disputed', U, 'c2', 3)], policy).status).toBe('open')
  })
  it('an outsider cannot get ahead of an in-graph claim', () => {
    expect(tradeState(offer, [claim('c2', U, 2), claim('c1', T, 3)], policy).claim.pubkey).toBe(T)
  })
  it('maker can explicitly select an outsider with a bound stamp', () => {
    const c = claim('c2', U, 2)
    const s = tradeState(offer, [c, stamp('settled', M, 'c2', 3)], policy)
    expect(s.claim.pubkey).toBe(U)
    expect(s.status).toBe('stamped')
  })
  it('backdated or wrong-counterparty maker stamps do not admit an outsider', () => {
    const c = claim('c2', U, 2)
    expect(tradeState(offer, [c, stamp('settled', M, 'c2', 1)], policy).status).toBe('open')
    expect(tradeState(offer, [c, { ...stamp('settled', M, 'c2', 3), counterparty: T }], policy).status).toBe('open')
  })
})

it('ignores claims at or after offer expiration while keeping earlier claims', () => {
 const o={...offer,expiresAt:10}
 expect(tradeState(o,[claim('late',T,10)]).claim).toBeNull()
 expect(tradeState(o,[claim('later',T,11)]).claim).toBeNull()
 expect(tradeState(o,[claim('early',T,9)]).claim.id).toBe('early')
})
