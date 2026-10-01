import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { offer, claim, settled, parse } from '../events.js'
import { createRanker } from '../wot.js'
import { createBrain, rejectReason, DEFAULT_POLICY } from './brain.js'

const key = () => {
  const sk = generateSecretKey()
  return { sk, pk: getPublicKey(sk) }
}
const owner = key(), agent = key(), friend = key(), far = key(), rival = key()
const now = Math.floor(Date.now() / 1000)
const ev = (t, who) => parse(finalizeEvent({ ...t, created_at: now }, who.sk))
const follows = (who, pks) => finalizeEvent({ kind: 3, created_at: now, tags: pks.map((p) => ['p', p]), content: '' }, who.sk)

// owner follows friend; friend follows far (2 hops).
const ranker = (stamps = []) =>
  createRanker({ viewer: owner.pk, followLists: [follows(owner, [friend.pk]), follows(friend, [far.pk])], stamps })

const mkOffer = (who, inr = 200) => ev(offer({ vpa: 'shop@okaxis', payee: 'Shop', inr, sats: inr * 12 }), who)
const setup = () => createBrain({ me: agent.pk, owner: owner.pk, lnAddress: 'owner@wallet.com' })

describe('agent policy', () => {
  const ctx = (events) => ({ ranker: ranker(), events, me: agent.pk, owner: owner.pk, policy: DEFAULT_POLICY, now })

  it('only takes offers from people the owner follows', () => {
    const a = mkOffer(friend), b = mkOffer(far)
    expect(rejectReason(a, ctx([a]))).toBeNull()
    expect(rejectReason(b, ctx([b]))).toBe('not followed by owner')
  })

  it('skips big offers, own offers and makers with disputes', () => {
    const big = mkOffer(friend, 5000), own = mkOffer(owner)
    expect(rejectReason(big, ctx([big]))).toBe('over max amount')
    expect(rejectReason(own, ctx([own]))).toBe('own offer')
    const o = mkOffer(friend)
    const bad = ev({ kind: 3404, tags: [['e', 'b'.repeat(64), '', 'root'], ['p', friend.pk], ['t', 'wot-pay']], content: '{"v":1,"reason":"x"}' }, owner)
    const r = ranker([bad])
    expect(rejectReason(o, { ...ctx([o]), ranker: r })).toBe('has disputes')
  })
})

describe('agent flow', () => {
  it('claims, asks the owner to pay by UPI, and sends sats to the owner', () => {
    const brain = setup()
    const o = mkOffer(friend)
    const acts = brain.onBoard({ events: [o], ranker: ranker(), now })
    expect(acts.map((a) => a.type)).toEqual(['claim', 'dm'])
    expect(JSON.parse(acts[0].template.content).receive).toEqual({ method: 'lightning', address: 'owner@wallet.com' })
    expect(acts[1].text).toContain('upi://pay?pa=shop%40okaxis')
    expect(brain.onBoard({ events: [o], ranker: ranker(), now })).toEqual([])
  })

  it('goes paid -> maker stamp -> got, and stamps the right claim', () => {
    const brain = setup()
    const o = mkOffer(friend)
    const [c] = brain.onBoard({ events: [o], ranker: ranker(), now })
    const myClaim = ev(c.template, agent)
    expect(brain.onOwnerMessage('Paid!')[0].text).toMatch(/Noted/)
    const s = ev(settled({ offerId: o.id, claimId: myClaim.id, counterparty: agent.pk }), friend)
    const [dm] = brain.onBoard({ events: [o, myClaim, s], ranker: ranker(), now })
    expect(dm.text).toMatch(/got/)
    const [stamp, done] = brain.onOwnerMessage('got')
    expect(stamp.type).toBe('stamp')
    expect(stamp.template.kind).toBe(3403)
    expect(stamp.template.tags).toContainEqual(['e', myClaim.id, '', 'reply'])
    expect(done.type).toBe('dm')
    expect(brain.state.active).toBeNull()
  })

  it('tells the owner not to pay when someone else claimed first', () => {
    const brain = setup()
    const o = mkOffer(friend)
    const [c] = brain.onBoard({ events: [o], ranker: ranker(), now })
    const theirs = parse(finalizeEvent({ ...claim({ offerId: o.id, maker: friend.pk }), created_at: now - 5 }, rival.sk))
    const [dm] = brain.onBoard({ events: [o, theirs, ev(c.template, agent)], ranker: ranker(), now })
    expect(dm.text).toMatch(/Don’t pay/)
    expect(brain.state.active).toBeNull()
  })

  it('pause stops new claims', () => {
    const brain = setup()
    brain.onOwnerMessage('pause')
    expect(brain.onBoard({ events: [mkOffer(friend)], ranker: ranker(), now })).toEqual([])
  })
})

describe('agent edge cases', () => {
  it('owner says skip: drops the trade and moves on', () => {
    const brain = setup()
    brain.onBoard({ events: [mkOffer(friend)], ranker: ranker(), now })
    expect(brain.onOwnerMessage('skip')[0].text).toMatch(/Don’t pay/)
    expect(brain.state.active).toBeNull()
    const next = mkOffer(friend, 300)
    expect(brain.onBoard({ events: [next], ranker: ranker(), now })[0].type).toBe('claim')
  })

  it('maker disputes: owner is told, and "no" stamps disputed', () => {
    const brain = setup()
    const o = mkOffer(friend)
    const [c] = brain.onBoard({ events: [o], ranker: ranker(), now })
    const mine = ev(c.template, agent)
    brain.onOwnerMessage('paid')
    const d = ev({ kind: 3404, tags: [['t', 'wot-pay'], ['e', o.id, '', 'root'], ['e', mine.id, '', 'reply'], ['p', agent.pk]], content: '{"v":1,"reason":"no UPI payment received"}' }, friend)
    const [dm] = brain.onBoard({ events: [o, mine, d], ranker: ranker(), now })
    expect(dm.text).toMatch(/didn’t arrive/)
    const [stamp] = brain.onOwnerMessage('no')
    expect(stamp.template.kind).toBe(3404)
  })

  it('skips stale and expired offers', () => {
    const brain = setup()
    const stale = { ...mkOffer(friend), created_at: now - 3600 }
    const expired = { ...mkOffer(friend), expiresAt: now - 1 }
    expect(brain.onBoard({ events: [stale, expired], ranker: ranker(), now })).toEqual([])
  })

  it('a claim that never reached a relay is forgotten', () => {
    const brain = setup()
    brain.onBoard({ events: [mkOffer(friend)], ranker: ranker(), now })
    brain.claimFailed()
    expect(brain.state.active).toBeNull()
  })

  it('ignores "got" before the owner has paid, and chatter with nothing open', () => {
    const brain = setup()
    expect(brain.onOwnerMessage('got')[0].text).toMatch(/Nothing open/)
    brain.onBoard({ events: [mkOffer(friend)], ranker: ranker(), now })
    const r = brain.onOwnerMessage('got')
    expect(r).toHaveLength(1)
    expect(r[0].type).toBe('dm')
    expect(brain.state.active).not.toBeNull()
  })
})
