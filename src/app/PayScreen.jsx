import { useCallback, useEffect, useMemo, useState } from 'react'
import { readToken } from '../dm.js'
import { offer as offerEvent, settled, disputed } from '../events.js'
import { tradeState } from '../trade.js'
import { inrPerBtc, inrToSats } from './rate.js'
import Scanner from './Scanner.jsx'
import { prefs } from './identity.js'
import { Name, TrustBadge, Steps, Copy, MintChip, mintName, rupees, sats, ago } from './ui.jsx'

// Maker: scan a QR, post it, watch for a claim, send sats, stamp.
export default function PayScreen({ board, signer, activeId, setActiveId }) {
  const [draft, setDraft] = useState(null)
  const mine = activeId && board.events.find((e) => e.id === activeId)

  if (mine) return <Live board={board} signer={signer} offer={mine} onDone={() => setActiveId(null)} />
  if (draft)
    return (
      <Confirm
        draft={draft}
        signer={signer}
        board={board}
        onBack={() => setDraft(null)}
        onPosted={(id) => {
          setDraft(null)
          setActiveId(id)
        }}
      />
    )
  return <Scan onResult={setDraft} />
}

function Scan({ onResult }) {
  const cb = useCallback((upi) => onResult(upi), [onResult])
  return (
    <section className="screen">
      <Steps at={0} labels={['Scan', 'Post', 'Paid', 'Settle']} />
      <h1>Scan a UPI QR</h1>
      <p className="lede">Someone you trust pays it in rupees. You pay them back in sats.</p>
      <Scanner onResult={cb} />
    </section>
  )
}

function Confirm({ draft, signer, board, onBack, onPosted }) {
  const [inr, setInr] = useState(draft.inr ? String(draft.inr) : '')
  const [price, setPrice] = useState(null)
  const [satsIn, setSatsIn] = useState('')
  const [mint, setMint] = useState(prefs.mint())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    inrPerBtc().then(setPrice)
  }, [])

  const amount = Number(inr)
  const suggested = useMemo(() => inrToSats(amount, price), [amount, price])
  const total = Number(satsIn) || suggested

  async function post() {
    setBusy(true)
    setError('')
    try {
      const m = mint.trim() || undefined
      const t = offerEvent({ vpa: draft.vpa, payee: draft.payee, inr: amount, sats: total, mint: m, note: draft.note })
      const signed = await signer.sign(t)
      prefs.setMint(mint.trim())
      await board.publish(signed)
      onPosted(signed.id)
    } catch (e) {
      setError(e.message.replace('invalid event: ', 'Check the '))
      setBusy(false)
    }
  }

  return (
    <section className="screen">
      <Steps at={1} labels={['Scan', 'Post', 'Paid', 'Settle']} />
      <div className="card payee">
        <div className="avatar">{(draft.payee || draft.vpa)[0].toUpperCase()}</div>
        <div>
          <div className="big">{draft.payee || 'UPI payee'}</div>
          <div className="mono dim">{draft.vpa}</div>
        </div>
      </div>

      <label className="field">
        <span>Amount</span>
        <div className="amount">
          <span>₹</span>
          <input inputMode="decimal" value={inr} onChange={(e) => setInr(e.target.value)} placeholder="0" autoFocus={!draft.inr} />
        </div>
      </label>

      <label className="field">
        <span>You pay back</span>
        <div className="amount small">
          <input
            inputMode="numeric"
            value={satsIn}
            onChange={(e) => setSatsIn(e.target.value.replace(/\D/g, ''))}
            placeholder={suggested ? String(suggested) : 'sats'}
          />
          <span>sats</span>
        </div>
        <small className="dim">
          {price ? `At ${rupees(Math.round(price))}/BTC. Add a little extra to get picked faster.` : 'Price unavailable, enter sats yourself.'}
        </small>
      </label>

      <label className="field">
        <span>Your Cashu mint (optional)</span>
        <input
          value={mint}
          onChange={(e) => setMint(e.target.value)}
          placeholder="https://mint.minibits.cash/Bitcoin"
          autoCapitalize="none"
          autoCorrect="off"
          inputMode="url"
        />
        <small className="dim">Shown on the offer so people know where the ecash comes from. Only the URL is public.</small>
      </label>

      {error && <p className="hint warn">{error}</p>}
      <div className="actions">
        <button className="btn ghost" onClick={onBack}>
          Back
        </button>
        <button className="btn primary" disabled={busy || !(amount > 0) || !(total > 0)} onClick={post}>
          {busy ? 'Posting…' : `Post for ${amount > 0 ? rupees(amount) : '₹0'}`}
        </button>
      </div>
      <p className="fine">Posted to public Nostr relays. Your web of trust sees it first. No sats move until you send them.</p>
    </section>
  )
}

function Live({ board, signer, offer, onDone }) {
  const state = tradeState(offer, board.events)
  const { claim, makerStamp, status } = state
  const [busy, setBusy] = useState(false)

  async function stamp(kind) {
    setBusy(true)
    try {
      const args = { offerId: offer.id, claimId: claim.id, counterparty: claim.pubkey }
      const t = kind === 'settled' ? settled(args) : disputed({ ...args, reason: 'no UPI payment received' })
      await board.publish(await signer.sign(t))
    } finally {
      setBusy(false)
    }
  }

  const step = status === 'open' ? 1 : makerStamp ? 3 : 2
  const receive = claim?.receive

  return (
    <section className="screen">
      <Steps at={step} labels={['Scan', 'Post', 'Paid', 'Settle']} />
      <div className="card summary">
        <div className="big">{rupees(offer.inr)}</div>
        <div className="dim">
          to {offer.payee || offer.vpa} · {sats(offer.sats)} back
        </div>
        <MintChip mint={offer.mint} />
      </div>

      {status === 'open' && (
        <div className="card waiting">
          <div className="pulse" />
          <div>
            <div className="big">Waiting for someone to pay</div>
            <div className="dim">Posted {ago(offer.created_at)}. People close to you see it at the top.</div>
          </div>
        </div>
      )}

      {claim && !makerStamp && (
        <div className="card claim">
          <div className="row">
            <Name pubkey={claim.pubkey} names={board.names} you={signer.pubkey} />
            <TrustBadge trust={board.ranker.explain(claim.pubkey)} />
          </div>
          <p>
            is paying <b>{rupees(offer.inr)}</b> to {offer.payee || offer.vpa}. When the payee confirms, send{' '}
            <b>{sats(offer.sats)}</b>.
          </p>
          {receive?.method === 'lightning' && (
            <div className="payto">
              <span className="mono">{receive.address}</span>
              <Copy text={receive.address} />
              <a className="btn small" href={`lightning:${receive.address}`}>
                Wallet
              </a>
            </div>
          )}
          {receive?.method === 'cashu' && <SendToken board={board} signer={signer} offer={offer} claim={claim} />}
          {state.claims.length > 1 && <p className="dim">{state.claims.length - 1} more waiting behind them.</p>}
          <div className="actions">
            <button className="btn ghost danger" disabled={busy} onClick={() => stamp('disputed')}>
              Not paid
            </button>
            <button className="btn primary" disabled={busy} onClick={() => stamp('settled')}>
              I sent the sats
            </button>
          </div>
        </div>
      )}

      {makerStamp && (
        <div className={`card done ${makerStamp.type}`}>
          <div className="big">{makerStamp.type === 'settled' ? 'Done. Stamped settled.' : 'Stamped disputed.'}</div>
          <div className="dim">
            {state.takerStamp
              ? `They stamped ${state.takerStamp.type} too.`
              : 'Waiting for their stamp. Both stamps are public and feed everyone’s trust scores.'}
          </div>
          <button className="btn primary" onClick={onDone}>
            Pay another QR
          </button>
        </div>
      )}
    </section>
  )
}

// Paste a token from your wallet; it goes to the taker as an encrypted DM.
function SendToken({ board, signer, offer, claim }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const sent = board.cash.forOffer(offer.id, signer.pubkey)
  const t = readToken(text)
  const want = claim.receive.mint

  if (!board.cash.supported) return <p className="hint warn">They want Cashu. Private DMs need the key on this device.</p>

  if (sent.length)
    return (
      <div className="tokenbox sent">
        <div>✓ Sent {sats(sent.reduce((n, x) => n + x.amount, 0))} as ecash by private DM</div>
        <small className="dim">Only they can open it. Nothing about the token is public.</small>
      </div>
    )

  async function go() {
    setBusy(true)
    setError('')
    try {
      await board.cash.send(claim.pubkey, t.token, offer.id)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="tokenbox">
      <label className="field">
        <span>They want ecash{want ? ` from ${mintName(want)}` : ''}. Paste a token from your wallet.</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="cashuB…" rows={3} spellCheck={false} />
      </label>
      {text && !t && <p className="hint warn">That doesn’t look like a Cashu token.</p>}
      {t && (
        <div className="dim">
          {sats(t.amount)} · {mintName(t.mint)}
          {t.amount < offer.sats && <span className="warn-text"> · {sats(offer.sats - t.amount)} short</span>}
          {want && t.mint !== want && <span className="warn-text"> · not the mint they asked for</span>}
        </div>
      )}
      {error && <p className="hint warn">{error}</p>}
      <button className="btn primary wide" disabled={!t || busy} onClick={go}>
        {busy ? 'Sending…' : 'Send privately'}
      </button>
    </div>
  )
}
