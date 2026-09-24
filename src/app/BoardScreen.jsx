import { useMemo, useState } from 'react'
import { claim as claimEvent, settled, disputed } from '../events.js'
import { tradeState } from '../trade.js'
import { upiLink } from '../upi.js'
import { prefs } from './identity.js'
import { Name, TrustBadge, Steps, Copy, MintChip, rupees, sats, ago } from './ui.jsx'

// Taker: pick an offer from people you trust, pay it by UPI, get sats.
export default function BoardScreen({ board, signer }) {
  const [openId, setOpenId] = useState(null)
  const me = signer.pubkey

  const offers = useMemo(() => board.events.filter((e) => e.type === 'offer'), [board.events])
  const withState = useMemo(() => offers.map((o) => ({ o, s: tradeState(o, board.events) })), [offers, board.events])

  const mine = withState.filter(({ s }) => s.claim?.pubkey === me && s.status !== 'settled').map(({ o }) => o)
  const open = board.ranker.rank(withState.filter(({ o, s }) => s.status === 'open' && o.pubkey !== me).map(({ o }) => o))

  const current = openId && offers.find((o) => o.id === openId)
  if (current) return <Detail board={board} signer={signer} offer={current} onBack={() => setOpenId(null)} />

  return (
    <section className="screen">
      <h1>Pay for someone</h1>
      <p className="lede">Pay a QR in rupees, get sats back. Closest people first.</p>

      {mine.length > 0 && (
        <>
          <h2>Your trades</h2>
          {mine.map((o) => (
            <OfferRow key={o.id} o={o} board={board} me={me} onOpen={setOpenId} active />
          ))}
        </>
      )}

      <h2>
        Open now <span className="dim">{board.trustLoading ? '· loading your web…' : `· ${open.length}`}</span>
      </h2>
      {open.length === 0 && <div className="empty">Nothing open right now. New offers show up here live.</div>}
      {open.map((o) => (
        <OfferRow key={o.id} o={o} board={board} me={me} onOpen={setOpenId} />
      ))}
    </section>
  )
}

function OfferRow({ o, board, me, onOpen, active }) {
  return (
    <button className={`card offer ${active ? 'active' : ''}`} onClick={() => onOpen(o.id)}>
      <div className="row">
        <div className="big">{rupees(o.inr)}</div>
        <div className="sats">{sats(o.sats)}</div>
      </div>
      <div className="row">
        <span className="dim">
          <Name pubkey={o.pubkey} names={board.names} you={me} /> · {o.payee || o.vpa} · {ago(o.created_at)}
        </span>
      </div>
      <div className="row start">
        <TrustBadge trust={o.trust || board.ranker.explain(o.pubkey)} />
        <MintChip mint={o.mint} />
      </div>
    </button>
  )
}

function Detail({ board, signer, offer, onBack }) {
  const me = signer.pubkey
  const state = tradeState(offer, board.events)
  const mineClaim = state.claims.find((c) => c.pubkey === me)
  const leading = state.claim?.pubkey === me
  const myStamp = state.takerStamp && leading ? state.takerStamp : null
  const [ln, setLn] = useState(prefs.lnAddress())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const trust = board.ranker.explain(offer.pubkey)

  async function send(template) {
    setBusy(true)
    setError('')
    try {
      await board.publish(await signer.sign(template))
    } catch (e) {
      setError(e.message.replace('invalid event: ', 'Check the '))
    } finally {
      setBusy(false)
    }
  }

  const doClaim = () => {
    prefs.setLnAddress(ln.trim())
    send(claimEvent({ offerId: offer.id, maker: offer.pubkey, receive: { method: 'lightning', address: ln.trim() } }))
  }
  const stamp = (kind) => {
    const args = { offerId: offer.id, claimId: mineClaim.id, counterparty: offer.pubkey }
    send(kind === 'settled' ? settled(args) : disputed({ ...args, reason: 'paid UPI, no sats' }))
  }

  const step = !mineClaim ? 0 : myStamp ? 3 : state.makerStamp ? 2 : 1

  return (
    <section className="screen">
      <button className="back" onClick={onBack}>
        ← Board
      </button>
      <Steps at={step} labels={['Claim', 'Pay UPI', 'Get sats', 'Settle']} />

      <div className="card summary">
        <div className="big">{rupees(offer.inr)}</div>
        <div className="dim">to {offer.payee || offer.vpa}</div>
        <div className="earn">You get {sats(offer.sats)}</div>
        <MintChip mint={offer.mint} />
      </div>

      <div className="card">
        <div className="row">
          <Name pubkey={offer.pubkey} names={board.names} you={me} />
          <TrustBadge trust={trust} />
        </div>
        <p className="dim">
          {trust.hops === null
            ? 'Nobody in your web knows this person. If they don’t send sats, you lose the rupees.'
            : `Score ${trust.score.toFixed(2)}. Settles and disputes only count from people in your web.`}
        </p>
      </div>

      {!mineClaim && (
        <div className="card">
          <label className="field">
            <span>Where should sats go?</span>
            <input
              value={ln}
              onChange={(e) => setLn(e.target.value)}
              placeholder="you@walletofsatoshi.com"
              autoCapitalize="none"
              autoCorrect="off"
              inputMode="email"
            />
          </label>
          {error && <p className="hint warn">{error}</p>}
          <button className="btn primary wide" disabled={busy || !ln.includes('@')} onClick={doClaim}>
            {busy ? 'Claiming…' : 'Claim and pay'}
          </button>
        </div>
      )}

      {mineClaim && !leading && <div className="card dim">Someone claimed it before you. You’re next in line.</div>}

      {mineClaim && leading && !myStamp && (
        <div className="card">
          <p>
            Pay <b>{rupees(offer.inr)}</b> to <span className="mono">{offer.vpa}</span>
          </p>
          <div className="actions">
            <Copy text={offer.vpa} label="Copy UPI ID" />
            <a className="btn primary" href={upiLink(offer)}>
              Open UPI app
            </a>
          </div>
          <p className="dim">
            {state.makerStamp?.type === 'settled'
              ? 'They say the sats are sent. Check your wallet.'
              : 'After you pay, they send the sats to your address.'}
          </p>
          <div className="actions">
            <button className="btn ghost danger" disabled={busy} onClick={() => stamp('disputed')}>
              No sats
            </button>
            <button className="btn primary" disabled={busy} onClick={() => stamp('settled')}>
              Got the sats
            </button>
          </div>
        </div>
      )}

      {myStamp && (
        <div className={`card done ${myStamp.type}`}>
          <div className="big">{myStamp.type === 'settled' ? 'Settled. Nice.' : 'Stamped disputed.'}</div>
          <div className="dim">Your stamp is public and counts in your web’s trust scores.</div>
          <button className="btn primary" onClick={onBack}>
            Back to board
          </button>
        </div>
      )}
    </section>
  )
}
