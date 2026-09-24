import { describe, it, expect } from 'vitest'
import { createRanker, buildGraph, hopDistances } from './wot.js'

const pk = (c) => c.repeat(64)
const V = pk('0') // viewer
const A = pk('a') // 1 hop
const B = pk('b') // 2 hops
const C = pk('c') // 3 hops
const X = pk('e') // outside the graph

const follows = (author, list, created_at = 1) => ({
  kind: 3, pubkey: author, created_at, tags: list.map((p) => ['p', p]),
})
const graph = [follows(V, [A]), follows(A, [B]), follows(B, [C])]

let n = 0
const offerBy = (pubkey, created_at = 100) => ({ type: 'offer', id: String(++n), pubkey, created_at })
const stamp = (type, author, counterparty, offerId, created_at = 50) => ({
  type, pubkey: author, counterparty, offerId, created_at,
})

describe('wot', () => {
  it('computes hop distances and keeps the newest follow list', () => {
    const d = hopDistances(buildGraph(graph), V)
    expect([d.get(A), d.get(B), d.get(C), d.get(X)]).toEqual([1, 2, 3, undefined])
    const g = buildGraph([follows(V, [A], 1), follows(V, [B], 2)])
    expect([...g.get(V)]).toEqual([B])
  })

  it('ranks a 1-hop offer above a 3-hop one with the same settle count', () => {
    const stamps = [stamp('settled', V, A, 'o1'), stamp('settled', V, C, 'o2')]
    const r = createRanker({ viewer: V, followLists: graph, stamps })
    const ranked = r.rank([offerBy(C, 200), offerBy(A, 100)])
    expect(ranked.map((o) => o.pubkey)).toEqual([A, C])
    expect(r.explain(A).settles).toBe(r.explain(C).settles)
  })

  it('a dispute lowers rank in a later query', () => {
    const stamps = [stamp('settled', V, A, 'o1'), stamp('settled', V, B, 'o2'), stamp('settled', A, B, 'o3')]
    const before = createRanker({ viewer: V, followLists: graph, stamps })
    expect(before.rank([offerBy(A), offerBy(B)])[0].pubkey).toBe(A)
    const b0 = before.explain(A).score

    const after = createRanker({
      viewer: V, followLists: graph, stamps: [...stamps, stamp('disputed', B, A, 'o4')],
    })
    expect(after.explain(A).score).toBeLessThan(b0)
    expect(after.rank([offerBy(A), offerBy(B)])[0].pubkey).toBe(B)
  })

  it('more settles raise the score', () => {
    const one = createRanker({ viewer: V, followLists: graph, stamps: [stamp('settled', V, B, 'o1')] })
    const three = createRanker({
      viewer: V, followLists: graph,
      stamps: ['o1', 'o2', 'o3'].map((o) => stamp('settled', V, B, o)),
    })
    expect(three.explain(B).score).toBeGreaterThan(one.explain(B).score)
  })

  it('ignores stamps from outside the graph, self-stamps and repeats', () => {
    const sybils = Array.from({ length: 20 }, (_, i) => stamp('settled', pk(String(i % 10)).replace(/^./, 'f'), X, `s${i}`))
    const r = createRanker({
      viewer: V, followLists: graph,
      stamps: [
        ...sybils,
        stamp('settled', A, A, 'self'),
        stamp('settled', V, B, 'dup', 1), stamp('settled', V, B, 'dup', 2),
      ],
    })
    expect(r.explain(X).settles).toBe(0)
    expect(r.explain(A).settles).toBe(0)
    expect(r.explain(B).settles).toBe(1)
  })

  it('drops expired offers', () => {
    const r = createRanker({ viewer: V, followLists: graph })
    const live = { ...offerBy(A), expiresAt: 2000 }
    const dead = { ...offerBy(A), expiresAt: 500 }
    expect(r.rank([live, dead], 1000)).toHaveLength(1)
  })
})
