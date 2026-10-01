// Decision logic for the agent, kept free of I/O so it can be tested.
// The agent claims offers from people its owner follows (1 hop), then DMs
// the owner to pay by UPI. Sats go straight to the owner's own address;
// the agent never holds sats and never touches a UPI app.
import { claim, settled, disputed } from '../events.js'
import { tradeState } from '../trade.js'
import { upiLink } from '../upi.js'

export const DEFAULT_POLICY = { maxInr: 500, minSatsPerInr: 0, maxAgeSec: 1800 }

// Why an offer is or isn't worth claiming. Returns null if it is.
export function rejectReason(offer, { ranker, events, me, owner, policy, now }) {
  if (offer.pubkey === me || offer.pubkey === owner) return 'own offer'
  if (tradeState(offer, events).status !== 'open') return 'not open'
  const t = ranker.explain(offer.pubkey)
  if (t.hops !== 1) return 'not followed by owner'
  if (t.disputes > 0) return 'has disputes'
  if (offer.inr > policy.maxInr) return 'over max amount'
  if (offer.sats / offer.inr < policy.minSatsPerInr) return 'rate too low'
  if (now - offer.created_at > policy.maxAgeSec) return 'too old'
  return null
}

const inr = (n) => `₹${Number(n).toLocaleString('en-IN')}`
const sat = (n) => `${Number(n).toLocaleString('en-IN')} sats`

export function createBrain({ me, owner, lnAddress, policy = DEFAULT_POLICY, label = 'the maker' }) {
  const state = { paused: false, active: null, tried: new Set() }
  const name = typeof label === 'function' ? label : () => label

  function onBoard({ events, ranker, now = Math.floor(Date.now() / 1000) }) {
    const a = state.active
    if (a) return follow(a, events)
    if (state.paused) return []

    const offers = ranker.rank(events.filter((e) => e.type === 'offer' && !state.tried.has(e.id)), now)
    const pick = offers.find((o) => !rejectReason(o, { ranker, events, me, owner, policy, now }))
    if (!pick) return []

    state.tried.add(pick.id)
    state.active = { offer: pick, phase: 'claimed', told: null }
    const t = pick.trust
    const record = t.settles ? `${t.settles} settled, no disputes` : 'no trades yet'
    return [
      {
        type: 'claim',
        template: claim({ offerId: pick.id, maker: pick.pubkey, receive: { method: 'lightning', address: lnAddress } }),
      },
      {
        type: 'dm',
        text:
          `New trade: pay ${inr(pick.inr)} to ${pick.payee || pick.vpa} (${pick.vpa}). ` +
          `You get ${sat(pick.sats)} at ${lnAddress}. ${name(pick.pubkey)} is someone you follow, ${record}.\n\n` +
          `${upiLink(pick)}\n\nReply "paid" when done, or "skip".`,
      },
    ]
  }

  function follow(a, events) {
    const st = tradeState(a.offer, events)
    const mine = st.claims.find((c) => c.pubkey === me)
    if (!mine) return []
    a.claimId = mine.id

    if (st.claim && st.claim.pubkey !== me) {
      state.active = null
      return [{ type: 'dm', text: `Someone else got the ${inr(a.offer.inr)} trade first.${a.phase === 'paid' ? ' You already paid: tell me "no" if the sats never come.' : ' Don’t pay it.'}` }]
    }
    if (st.makerStamp && a.told !== st.makerStamp.id) {
      a.told = st.makerStamp.id
      a.phase = 'confirm'
      return [
        {
          type: 'dm',
          text:
            st.makerStamp.type === 'settled'
              ? `${name(a.offer.pubkey)} says ${sat(a.offer.sats)} went to ${lnAddress}. Reply "got" once you see them, or "no".`
              : `${name(a.offer.pubkey)} says the UPI payment didn’t arrive. Reply "no" to dispute, or "got" if it’s sorted.`,
        },
      ]
    }
    return []
  }

  function onOwnerMessage(raw) {
    const cmd = (String(raw).toLowerCase().match(/[a-z]+/) || [''])[0]
    const a = state.active
    const reply = (text) => [{ type: 'dm', text }]

    if (cmd === 'pause') {
      state.paused = true
      return reply(a ? 'Paused. I’ll still finish the current trade.' : 'Paused. I won’t claim anything new.')
    }
    if (cmd === 'resume') {
      state.paused = false
      return reply(`Back on. Watching for offers up to ${inr(policy.maxInr)} from people you follow.`)
    }
    if (cmd === 'status') {
      if (!a) return reply(state.paused ? 'Paused, nothing open.' : `Watching. Up to ${inr(policy.maxInr)}, people you follow only.`)
      return reply(`${inr(a.offer.inr)} to ${a.offer.vpa} for ${sat(a.offer.sats)}: ${a.phase}.`)
    }
    if (!a) return reply('Nothing open. Commands: status, pause, resume.')

    if (cmd === 'paid' && a.phase === 'claimed') {
      a.phase = 'paid'
      return reply('Noted. I’ll tell you when the sats are on their way.')
    }
    if (cmd === 'skip' && a.phase === 'claimed') {
      state.active = null
      return reply('Dropped. Don’t pay it.')
    }
    if ((cmd === 'got' || cmd === 'no') && a.phase !== 'claimed' && a.claimId) {
      state.active = null
      const args = { offerId: a.offer.id, claimId: a.claimId, counterparty: a.offer.pubkey }
      return [
        { type: 'stamp', template: cmd === 'got' ? settled(args) : disputed({ ...args, reason: 'paid UPI, no sats' }) },
        { type: 'dm', text: cmd === 'got' ? 'Stamped settled. Watching for the next one.' : 'Stamped disputed. Watching for the next one.' },
      ]
    }
    return reply(a.phase === 'claimed' ? 'Reply "paid" or "skip".' : 'Reply "got" or "no".')
  }

  // The claim never reached a relay: forget it so the owner isn't told to pay.
  function claimFailed() {
    if (state.active?.phase === 'claimed' && !state.active.claimId) state.active = null
  }

  return { onBoard, onOwnerMessage, claimFailed, state }
}
