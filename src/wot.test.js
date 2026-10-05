import { describe, it, expect, beforeEach } from 'vitest'
import { createRanker, buildGraph, hopDistances } from './wot.js'

const pk = (c) => c.repeat(64)
const V = pk('0') // viewer
const A = pk('a') // 1 hop
const B = pk('b') // 2 hops
const C = pk('c') // 3 hops
const X = pk('e') // outside the graph

const follows = (author, list, created_at = 1) => ({
  kind: 3,
  pubkey: author,
  created_at,
  tags: list.map((p) => ['p', p]),
})
const graph = [follows(V, [A]), follows(A, [B]), follows(B, [C])]

let n = 0
const offerBy = (pubkey, created_at = 100) => ({ type: 'offer', id: String(++n), pubkey, created_at })
const tradeEvidence = []
beforeEach(() => {
  tradeEvidence.length = 0
})
const stamp = (type, author, counterparty, offerId, created_at = 50) => {
  const claimId = 'claim-' + offerId
  if (!tradeEvidence.some((e) => e.id === offerId))
    tradeEvidence.push(
      { type: 'offer', id: offerId, pubkey: author, created_at: 0 },
      { type: 'claim', id: claimId, offerId, pubkey: counterparty, maker: author, created_at: 0 },
    )
  return { type, pubkey: author, counterparty, offerId, claimId, created_at }
}
const originalRanker = createRanker
const ranker = (args) => originalRanker({ ...args, events: tradeEvidence })

describe('wot', () => {
  it('computes hop distances and keeps the newest follow list', () => {
    const d = hopDistances(buildGraph(graph), V)
    expect([d.get(A), d.get(B), d.get(C), d.get(X)]).toEqual([1, 2, 3, undefined])
    const g = buildGraph([follows(V, [A], 1), follows(V, [B], 2)])
    expect([...g.get(V)]).toEqual([B])
  })

  it('ranks a 1-hop offer above a 3-hop one with the same settle count', () => {
    const stamps = [stamp('settled', V, A, 'o1'), stamp('settled', V, C, 'o2')]
    const r = ranker({ viewer: V, followLists: graph, stamps })
    const ranked = r.rank([offerBy(C, 200), offerBy(A, 100)])
    expect(ranked.map((o) => o.pubkey)).toEqual([A, C])
    expect(r.explain(A).settles).toBe(r.explain(C).settles)
  })

  it('a dispute lowers rank in a later query', () => {
    const stamps = [stamp('settled', V, A, 'o1'), stamp('settled', V, B, 'o2'), stamp('settled', A, B, 'o3')]
    const before = ranker({ viewer: V, followLists: graph, stamps })
    expect(before.rank([offerBy(A), offerBy(B)])[0].pubkey).toBe(A)
    const b0 = before.explain(A).score

    const after = ranker({
      viewer: V,
      followLists: graph,
      stamps: [...stamps, stamp('disputed', B, A, 'o4')],
    })
    expect(after.explain(A).score).toBeLessThan(b0)
    expect(after.rank([offerBy(A), offerBy(B)])[0].pubkey).toBe(B)
  })

  it('more settles raise the score', () => {
    const one = ranker({ viewer: V, followLists: graph, stamps: [stamp('settled', V, B, 'o1')] })
    const three = ranker({
      viewer: V,
      followLists: graph,
      stamps: ['o1', 'o2', 'o3'].map((o) => stamp('settled', V, B, o)),
    })
    expect(three.explain(B).score).toBeGreaterThan(one.explain(B).score)
  })

  it('ignores stamps from outside the graph, self-stamps and repeats', () => {
    const sybils = Array.from({ length: 20 }, (_, i) =>
      stamp('settled', pk(String(i % 10)).replace(/^./, 'f'), X, `s${i}`),
    )
    const r = ranker({
      viewer: V,
      followLists: graph,
      stamps: [
        ...sybils,
        stamp('settled', A, A, 'self'),
        stamp('settled', V, B, 'dup', 1),
        stamp('settled', V, B, 'dup', 2),
      ],
    })
    expect(r.explain(X).settles).toBe(0)
    expect(r.explain(A).settles).toBe(0)
    expect(r.explain(B).settles).toBe(1)
  })

  it('treats several keys as the viewer', () => {
    const d = hopDistances(buildGraph(graph), [X, V])
    expect(d.get(X)).toBe(0)
    expect(d.get(A)).toBe(1)
  })

  it('drops expired offers', () => {
    const r = ranker({ viewer: V, followLists: graph })
    const live = { ...offerBy(A), expiresAt: 2000 }
    const dead = { ...offerBy(A), expiresAt: 500 }
    expect(r.rank([live, dead], 1000)).toHaveLength(1)
  })
})

describe('receipt participation proof', () => {
  const offer = { type: 'offer', id: 'real-offer', pubkey: A, created_at: 1 }
  const claim = { type: 'claim', id: 'real-claim', offerId: offer.id, maker: A, pubkey: B, created_at: 2 }
  const receipt = {
    type: 'settled',
    pubkey: A,
    counterparty: B,
    offerId: offer.id,
    claimId: claim.id,
    created_at: 3,
  }
  const check = (stamps, events = [offer, claim]) =>
    createRanker({ viewer: V, followLists: graph, stamps, events }).explain(B)
  it('counts a real participant receipt', () => expect(check([receipt]).settles).toBe(1))
  it('drops nonexistent offer and claim receipts', () => {
    expect(check([receipt], []).settles).toBe(0)
    expect(check([receipt], [offer]).settles).toBe(0)
    expect(check([{ ...receipt, offerId: 'invented' }]).settles).toBe(0)
  })
  it('drops graph members who did not trade and wrong counterparties', () => {
    expect(check([{ ...receipt, pubkey: C }]).settles).toBe(0)
    expect(check([{ ...receipt, counterparty: X }]).settles).toBe(0)
    expect(check([receipt], [offer, { ...claim, maker: X }]).settles).toBe(0)
  })
  it('does not count receipts dated before the claim', () =>
    expect(check([{ ...receipt, created_at: 0 }]).settles).toBe(0))
})

describe('bounded reputation', () => {
  it('200 repeated pair receipts cannot outrank a direct follow', () => {
    const stamps = Array.from({ length: 200 }, (_, i) => stamp('settled', B, C, `repeat-${i}`, 100 + i))
    const r = ranker({ viewer: V, followLists: graph, stamps })
    expect(r.explain(C).settles).toBe(1.5)
    expect(r.explain(C).score).toBeLessThan(r.explain(A).score)
  })
  it('20 repeated disputes cannot drive a direct follow below a quarter of its base', () => {
    const stamps = Array.from({ length: 20 }, (_, i) => stamp('disputed', B, A, `dispute-${i}`, 100 + i))
    const r = ranker({ viewer: V, followLists: graph, stamps })
    expect(r.explain(A).disputes).toBe(1)
    expect(r.explain(A).score).toBe(0.25)
  })
  it('limits aggregate receipt weight even when many graph members collaborate', () => {
    const keys = Array.from({ length: 10 }, (_, i) => `friend-${i}`)
    const stamps = keys.map((k, i) => stamp('settled', k, C, `many-${i}`))
    const r = ranker({ viewer: V, followLists: [...graph, follows(V, [A, ...keys], 2)], stamps })
    expect(r.explain(C).settles).toBe(3)
    expect(r.explain(C).score).toBeCloseTo(0.6)
  })
  it('pair selection is independent of arrival order', () => {
    const stamps = Array.from({ length: 10 }, (_, i) => stamp(i % 2 ? 'settled' : 'disputed', B, C, `order-${i}`, 100 + i))
    const args = { viewer: V, followLists: graph }
    expect(ranker({ ...args, stamps }).explain(C)).toEqual(ranker({ ...args, stamps: [...stamps].reverse() }).explain(C))
  })
})
