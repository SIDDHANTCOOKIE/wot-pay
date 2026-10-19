import { tradeState } from '../trade.js'
import { useState } from 'react'
import { rupees, sats } from './ui.jsx'

export default function MyTrades({ board, signer, onOpen, onRequireIdentity }) {
  const [message, setMessage] = useState('')
  const [retrying, setRetrying] = useState(false)
  if (!signer) return <section className="screen"><h1>My trades</h1><p>Your trades will appear here after you choose an identity.</p><button className="btn primary" onClick={onRequireIdentity}>Choose identity</button></section>
  const trades = board.events.filter(e => e.type === 'offer').map(offer => ({ offer, state: tradeState(offer, board.events) }))
    .filter(({ offer, state }) => offer.pubkey === signer.pubkey || state.claims.some(c => c.pubkey === signer.pubkey))
    .sort((a,b) => Number(a.state.status === 'settled' || a.state.status === 'expired') - Number(b.state.status === 'settled' || b.state.status === 'expired') || b.offer.created_at - a.offer.created_at)
  return <section className="screen"><h1>My trades</h1><p className="lede">Active and unresolved trades first.</p>
    {!!board.pending?.length && <div className="card"><h2>Delivery unconfirmed</h2><p>{board.pending.length} saved signed event(s). Retrying sends the same event IDs; it does not create new trade instructions.</p><button className="btn ghost" disabled={retrying} onClick={async () => {
      setRetrying(true); setMessage('')
      try { for (const event of board.pending) await board.retryPending(event); setMessage('Saved events acknowledged by a relay.') }
      catch (e) { setMessage(e.message) } finally { setRetrying(false) }
    }}>Retry saved events</button></div>}
    {message && <p role="status">{message}</p>}
    <p className="dim">Legacy trades use external payments and have no escrow. Saved public history is loaded on this browser; missing relay data may leave the history incomplete.</p>
    {!trades.length && <div className="empty">No trades found for this identity yet.</div>}
    {trades.map(({offer, state}) => <button key={offer.id} className="card offer" onClick={() => onOpen(offer)}>
      <div className="row"><strong>{rupees(offer.inr)}</strong><span>{sats(state.agreedSats)}</span></div>
      <p>{offer.pubkey === signer.pubkey ? 'You requested payment' : 'You offered to pay'} · {state.status}</p><small>Legacy trade — no escrow{state.cancellationRequested ? ' · cancellation requested' : ''}</small>
    </button>)}
  </section>
}
