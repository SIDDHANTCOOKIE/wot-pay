import { KIND } from './kinds.js'
import { latestFollow } from './follows.js'
import { parse } from './events.js'

// Web-of-trust ranking.
// Trust comes from the viewer's follow graph (kind 3) plus public
// settled/disputed stamps. Stamps only count when their author is
// inside the viewer's graph, so a farm of fresh keys can't vouch for itself.

export const HOP_WEIGHT = [1, 1, 0.5, 0.2] // index = hops; 0 = the viewer
export const MAX_PAIR_STAMPS = 3
export const MAX_SETTLE_WEIGHT = 3
export const MAX_DISPUTE_WEIGHT = 1
export const OUTSIDE_WEIGHT = 0.05
export const MAX_HOPS = HOP_WEIGHT.length - 1

// followLists: kind-3 events. Keeps only the newest list per author.
export function buildGraph(followLists) {
  const latest = new Map([...new Set(followLists.filter(e => e?.kind === 3).map(e => e.pubkey))].map(pk => [pk, latestFollow(followLists, pk)]).filter(([,e]) => e))
  const graph = new Map()
  for (const [pk, ev] of latest) {
    graph.set(pk, new Set(ev.tags.filter((t) => t[0] === 'p' && t[1]).map((t) => t[1])))
  }
  return graph
}

// BFS from the viewer (or several keys that are all "you").
// Returns Map pubkey -> hop count (viewer = 0).
export function hopDistances(graph, viewer, maxHops = MAX_HOPS) {
  const roots = [].concat(viewer).filter(Boolean)
  const dist = new Map(roots.map((r) => [r, 0]))
  let frontier = roots
  for (let h = 1; h <= maxHops && frontier.length; h++) {
    const next = []
    for (const pk of frontier) {
      for (const f of graph.get(pk) || []) {
        if (!dist.has(f)) {
          dist.set(f, h)
          next.push(f)
        }
      }
    }
    frontier = next
  }
  return dist
}

const weightOf = (dist, pk) => {
  const h = dist.get(pk)
  return h === undefined ? OUTSIDE_WEIGHT : HOP_WEIGHT[h]
}

// stamps: parsed settled/disputed events (see events.parse).
// createRanker also accepts raw events and parses them.
// Returns Map pubkey -> { settles, disputes } weighted by stamp author trust.
// One stamp per (author, offer); a later stamp replaces an earlier one.
export function tallyStamps(stamps, dist, events = []) {
  const offers = new Map(events.filter((e) => e.type === 'offer').map((e) => [e.id, e]))
  const claims = new Map(events.filter((e) => e.type === 'claim').map((e) => [e.id, e]))
  const byKey = new Map()
  for (const s of stamps) {
    if (s.type !== 'settled' && s.type !== 'disputed') continue
    const offer = offers.get(s.offerId),
      claim = claims.get(s.claimId)
    if (
      !offer ||
      !claim ||
      claim.offerId !== offer.id ||
      claim.maker !== offer.pubkey ||
      claim.pubkey === offer.pubkey
    )
      continue
    if (!(
      (s.pubkey === offer.pubkey && s.counterparty === claim.pubkey) ||
      (s.pubkey === claim.pubkey && s.counterparty === offer.pubkey)
    ))
      continue
    if (s.created_at < claim.created_at || claim.created_at < offer.created_at) continue
    if (s.pubkey === s.counterparty) continue
    if (!dist.has(s.pubkey)) continue // author outside the graph: ignored
    const key = `${s.pubkey}:${s.offerId}`
    const prev = byKey.get(key)
    if (!prev || (s.created_at > prev.created_at || (s.created_at === prev.created_at && s.id < prev.id))) byKey.set(key, s)
  }
  const tally = new Map()
  const pairs = new Map()
  // One counterparty cannot supply unlimited reputation through repeated offers.
  const bounded = [...byKey.values()].sort((a, b) => b.created_at - a.created_at || String(a.id || a.offerId).localeCompare(String(b.id || b.offerId)))
  for (const s of bounded) {
    const pair = `${s.pubkey}:${s.counterparty}`
    const count = pairs.get(pair) || 0
    if (count >= MAX_PAIR_STAMPS) continue
    pairs.set(pair, count + 1)
    const t = tally.get(s.counterparty) || { settles: 0, disputes: 0 }
    const w = weightOf(dist, s.pubkey)
    if (s.type === 'settled') t.settles = Math.min(MAX_SETTLE_WEIGHT, t.settles + w)
    else t.disputes = Math.min(MAX_DISPUTE_WEIGHT, t.disputes + w)
    tally.set(s.counterparty, t)
  }
  return tally
}

// Trust score for one pubkey. Distance sets the base, settles raise it
// within a capped bonus; dispute weight is capped so repeated claims cannot erase the base.
export function trustScore(pk, dist, tally) {
  const t = tally.get(pk) || { settles: 0, disputes: 0 }
  const base = weightOf(dist, pk)
  return (base * (1 + Math.log2(1 + Math.min(MAX_SETTLE_WEIGHT, t.settles)))) / (1 + 3 * Math.min(MAX_DISPUTE_WEIGHT, t.disputes))
}

export function createRanker({ viewer, followLists = [], stamps = [], events = [] }) {
  const graph = buildGraph(followLists)
  const dist = hopDistances(graph, viewer)
  const parsed = stamps.map((s) => (s.type ? s : parse(s))).filter(Boolean)
  const tally = tallyStamps(parsed, dist, events.map((e) => (e.type ? e : parse(e))).filter(Boolean))

  const explain = (pk) => ({
    hops: dist.get(pk) ?? null,
    ...(tally.get(pk) || { settles: 0, disputes: 0 }),
    score: trustScore(pk, dist, tally),
  })

  // offers: parsed offer events. Drops expired ones, best first.
  function rank(offers, now = Math.floor(Date.now() / 1000)) {
    return offers
      .filter((o) => o.type === 'offer' && !(o.expiresAt && o.expiresAt < now))
      .map((o) => ({ ...o, trust: explain(o.pubkey) }))
      .sort((a, b) => b.trust.score - a.trust.score || b.created_at - a.created_at)
  }

  return { rank, explain, hops: dist }
}

// Fetch what the ranker needs from relays.
// query(filter) -> Promise<event[]> (e.g. relays.query from relays.js).
// Author lists are sent in chunks; big filters get dropped by relays.
const CHUNK = 100

async function queryAuthors(query, kinds, authors) {
  const out = []
  for (let i = 0; i < authors.length; i += CHUNK) {
    try {
      out.push(...(await query({ kinds, authors: authors.slice(i, i + CHUNK) })))
    } catch {
      // a failed chunk just means less data; ranking still works
    }
  }
  return out
}

export async function loadTrustData(query, viewer, { depth = 2, maxAuthors = 1000 } = {}) {
  const followLists = []
  const seen = new Set()
  let frontier = [viewer]
  for (let h = 0; h < depth && frontier.length; h++) {
    const batch = frontier.filter((pk) => !seen.has(pk)).slice(0, maxAuthors)
    batch.forEach((pk) => seen.add(pk))
    const events = await queryAuthors(query, [3], batch)
    followLists.push(...events)
    frontier = [...new Set([...buildGraph(events).values()].flatMap((f) => [...f]))]
  }
  const known = [...new Set([viewer, ...seen, ...frontier])].slice(0, maxAuthors)
  const stamps = await queryAuthors(query, [KIND.SETTLED, KIND.DISPUTED], known)
  // Resolve both ends of historical receipts. Missing evidence counts nothing.
  const parsed = stamps.map(parse).filter(Boolean)
  const ids = [...new Set(parsed.flatMap((s) => [s.offerId, s.claimId]).filter(Boolean))].slice(0, 2000)
  const trades = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    try {
      trades.push(...(await query({ ids: ids.slice(i, i + CHUNK), kinds: [KIND.OFFER, KIND.CLAIM] })))
    } catch {}
  }
  return { followLists, stamps, trades }
}
