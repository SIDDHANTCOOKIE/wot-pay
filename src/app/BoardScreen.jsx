import { useMemo, useState } from 'react'
import { claim as claimEvent, settled, disputed } from '../events.js'
import { tradeState } from '../trade.js'
import { tokenIssues } from '../dm.js'
import { upiLink } from '../upi.js'
import { prefs } from './identity.js'
import Orbit, { where, SettleMark } from './Orbit.jsx'
import { Name, TrustBadge, Steps, Copy, MintChip, mintName, rupees, sats, ago } from './ui.jsx'

// Taker: pick an offer from people you trust, pay it by UPI, get sats.
export default function BoardScreen({ board, signer }) {
  const [openId, setOpenId] = useState(() => {
    const match = location.hash.match(/^#offer\/([0-9a-f]{64})$/)
    return match?.[1] || null
  })
  const me = signer.pubkey

  const offers = useMemo(() => board.events.filter((e) => e.type === 'offer'), [board.events])
  const withState = useMemo(
    () => offers.map((o) => ({ o, s: tradeState(o, board.events) })),
    [offers, board.events],
  )

  const mine = withState.filter(({ s }) => s.claim?.pubkey === me && s.status !== 'settled').map(({ o }) => o)
  const open = board.ranker.rank(
    withState.filter(({ o, s }) => s.status === 'open' && o.pubkey !== me).map(({ o }) => o),
  )

  const current = openId && offers.find((o) => o.id === openId)
  if (openId && !current)
    return (
      <section className="screen">
        <h1>Opening offer</h1>
        <p>This public offer hasn't arrived from the relays yet. It may be old, removed or unavailable.</p>
        <button
          className="btn ghost"
          onClick={() => {
            setOpenId(null)
            location.hash = 'board'
          }}
        >
          Back to board
        </button>
      </section>
    )
  if (current)
    return (
      <Detail
        board={board}
        signer={signer}
        offer={current}
        onBack={() => {
          setOpenId(null)
          location.hash = 'board'
        }}
      />
    )

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
        Open now{' '}
        <span className="dim">
          {board.relaysUp === null
            ? '· connecting…'
            : board.relaysUp === 0
              ? '· offline'
              : board.trustLoading
                ? '· loading your web…'
                : `· ${open.length}`}
        </span>
      </h2>
      {open.length === 0 && (
        <div className="empty">
          {board.relaysUp === null
            ? 'Connecting to Nostr relays. Offers will appear here when they arrive.'
            : board.relaysUp === 0
              ? 'Can’t reach any relay right now, so the board may be missing offers. Check your connection.'
              : 'Nothing open right now. New offers show up here live.'}
        </div>
      )}
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
        <TrustBadge trust={o.trust || board.ranker.explain(o.pubkey)} pubkey={o.pubkey} />
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
  const [how, setHow] = useState(() => (board.cash.supported ? prefs.receive() : 'lightning'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [claimPending, setClaimPending] = useState(false)
  const trust = board.ranker.explain(offer.pubkey)

  async function send(buildTemplate) {
    setBusy(true)
    setError('')
    try {
      await board.publish(await signer.sign(buildTemplate()))
      return true
    } catch (e) {
      setError(e.message.replace('invalid event: ', 'Check the '))
      return false
    } finally {
      setBusy(false)
    }
  }

  const received = board.cash.forOffer(offer.id, offer.pubkey)
  const expired = state.status === 'expired'
  const canClaim =
    state.status === 'open' && !claimPending && (how === 'cashu' ? board.cash.supported : ln.includes('@'))

  const doClaim = async () => {
    if (busy || claimPending || state.status !== 'open' || mineClaim) return
    setClaimPending(true)
    prefs.setReceive(how)
    let receive = { method: 'cashu', mint: offer.mint }
    if (how === 'lightning') {
      prefs.setLnAddress(ln.trim())
      receive = { method: 'lightning', address: ln.trim() }
    }
    await send(() => claimEvent({ offerId: offer.id, maker: offer.pubkey, receive }))
    await new Promise((r) => setTimeout(r, 3000))
    setClaimPending(false)
  }
  const stamp = (kind) => {
    const args = { offerId: offer.id, claimId: mineClaim.id, counterparty: offer.pubkey }
    send(() => (kind === 'settled' ? settled(args) : disputed({ ...args, reason: 'paid UPI, no sats' })))
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

      <div className="card trust-card">
        <Orbit trust={trust} pubkey={offer.pubkey} size={92} />
        <div className="trust-copy">
          <Name pubkey={offer.pubkey} names={board.names} you={me} />
          <div className="where">{where(trust)}</div>
          <div className="rec">
            {trust.settles || 0} settled · {trust.disputes || 0} disputed
          </div>
        </div>
        <p className="dim trust-note">
          {trust.hops === null
            ? 'Nobody in your web knows this person. If they don’t send sats, you lose the rupees.'
            : `Score ${trust.score.toFixed(2)}. Settles and disputes only count from people in your web.`}
        </p>
      </div>

      {!mineClaim && (
        <div className="card">
          <div className="field">
            <span>How do you want the sats?</span>
            <div className="seg">
              <button className={how === 'lightning' ? 'on' : ''} onClick={() => setHow('lightning')}>
                Lightning
              </button>
              <button className={how === 'cashu' ? 'on' : ''} onClick={() => setHow('cashu')}>
                Ecash
              </button>
            </div>
          </div>
          {how === 'lightning' ? (
            <input
              className="input"
              value={ln}
              onChange={(e) => setLn(e.target.value)}
              placeholder="you@walletofsatoshi.com"
              autoCapitalize="none"
              autoCorrect="off"
              inputMode="email"
            />
          ) : (
            <p className="dim">
              {board.cash.supported
                ? `A Cashu token${offer.mint ? ` from ${mintName(offer.mint)}` : ''} comes to you by encrypted DM. Only you can open it.`
                : 'Ecash DMs need the key on this device. Use Lightning, or switch back to the local key.'}
            </p>
          )}
          {error && <p className="hint warn">{error}</p>}
          <button className="btn primary wide" disabled={busy || !canClaim} onClick={doClaim}>
            {expired
              ? 'This offer expired'
              : state.status !== 'open'
                ? 'Already claimed'
                : busy || claimPending
                  ? 'Claiming…'
                  : 'Claim and pay'}
          </button>
        </div>
      )}

      {claimPending && (
        <div className="card dim" role="status">
          Claim pending. Waiting for relay updates. Do not pay yet.
        </div>
      )}
      {mineClaim && !leading && (
        <div className="card hint warn" role="status">
          Claim lost. Someone else leads this trade. Do not pay.
        </div>
      )}

      {mineClaim && leading && !myStamp && !claimPending && (
        <div className="card">
          <p>
            <span className="hint warn">
              You lead in the events currently received. Relay delay can still reveal another claim. Verify
              the maker agrees before paying.
            </span>
            Pay <b>{rupees(offer.inr)}</b> to <span className="mono">{offer.vpa}</span>
          </p>
          <div className="actions">
            <Copy text={offer.vpa} label="Copy UPI ID" />
            <a className="btn primary" href={upiLink(offer)}>
              Open UPI app
            </a>
          </div>
          {received.map((t) => (
            <div key={t.id} className="tokenbox got">
              <div className="big">
                {t.unit === 'sat' ? sats(t.amount) : `${t.amount} ${t.unit}`} token received
              </div>
              <div className="dim">from {mintName(t.mint)} · private DM</div>
              <div className="actions">
                <Copy text={t.token} label="Copy token" />
                <a className="btn primary" href={`cashu:${t.token}`}>
                  Open wallet
                </a>
              </div>
              {tokenIssues(t, { sats: offer.sats, mint: mineClaim.receive?.mint }).map((issue) => (
                <p key={issue} className="hint warn">
                  {issue}
                </p>
              ))}
              <p className="dim">
                Redeem in your wallet before confirming. Token spendability is not checked here.
              </p>
            </div>
          ))}
          {!received.length && (
            <p className="dim">
              {state.makerStamp?.type === 'settled'
                ? 'They say the sats are sent. Check your wallet.'
                : mineClaim.receive?.method === 'cashu'
                  ? 'After you pay, the token arrives here by private DM.'
                  : 'After you pay, they send the sats to your address.'}
            </p>
          )}
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
          <SettleMark ok={myStamp.type === 'settled'} />
          <div className="hero-word">
            {myStamp.type === 'settled'
              ? state.status === 'settled'
                ? 'Settled.'
                : 'You stamped settled.'
              : 'Disputed.'}
          </div>
          <div className="dim">Your stamp is public and counts in your web’s trust scores.</div>
          <button className="btn primary" onClick={onBack}>
            Back to board
          </button>
        </div>
      )}
    </section>
  )
}
