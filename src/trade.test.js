import { describe, it, expect } from 'vitest'
import { tradeState } from './trade.js'

const M = 'm'.repeat(64)
const T = 't'.repeat(64)
const U = 'u'.repeat(64)
const offer = { type: 'offer', id: 'o', pubkey: M, created_at: 1 }
const claim = (id, pubkey, created_at) => ({ type: 'claim', id, pubkey, offerId: 'o', maker: M, created_at })
const stamp = (type, pubkey, claimId, created_at) => ({ type, pubkey, offerId: 'o', claimId, created_at })

describe('tradeState', () => {
  it('walks open -> claimed -> settled', () => {
    expect(tradeState(offer, []).status).toBe('open')
    const c = claim('c1', T, 2)
    expect(tradeState(offer, [c]).status).toBe('claimed')
    expect(tradeState(offer, [c, stamp('settled', M, 'c1', 3)]).status).toBe('stamped')
    expect(tradeState(offer, [c, stamp('settled', M, 'c1', 3), stamp('settled', T, 'c1', 4)]).status).toBe('settled')
  })

  it('either side can dispute', () => {
    const c = claim('c1', T, 2)
    expect(tradeState(offer, [c, stamp('settled', M, 'c1', 3), stamp('disputed', T, 'c1', 4)]).status).toBe('disputed')
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
