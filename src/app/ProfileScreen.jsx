import { useEffect, useId, useMemo, useRef, useState } from 'react'
import RelayStatus from './RelayStatus.jsx'
import { tradeState } from '../trade.js'
import { Copy, Name, rupees, sats, ago } from './ui.jsx'
import * as nip19 from 'nostr-tools/nip19'

// Your key, how the board sees you, and every trade you touched.
export default function ProfileScreen({ board, signer, onClose, children }) {
  const [showRelays, setShowRelays] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  async function refresh() { setRefreshing(true); try { await board.refreshIdentity() } finally { setRefreshing(false) } }
  const relayButton = useRef(null)
  useEffect(() => { if (!showRelays) relayButton.current?.focus() }, [showRelays])
  const sheet = useRef(null)
  const titleId = useId()
  useEffect(() => {
    const previous = document.activeElement
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    sheet.current?.querySelector('button')?.focus()
    return () => {
      document.body.style.overflow = overflow
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    if (e.key !== 'Tab') return
    const controls = [...sheet.current.querySelectorAll('button, a[href], input, textarea, select, [tabindex]')]
      .filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length)
    const first = controls[0], last = controls.at(-1)
    if (!first) {
      e.preventDefault()
      sheet.current.focus()
    } else if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === sheet.current)) {
      e.preventDefault()
      first.focus()
    }
  }

  const me = signer.pubkey
  const npub = nip19.npubEncode(me)

  const trades = useMemo(() => {
    const offers = board.events.filter((e) => e.type === 'offer')
    return offers
      .map((o) => ({ o, s: tradeState(o, board.events, { trustedClaimers: board.ranker.hops }) }))
      .filter(({ o, s }) => o.pubkey === me || s.claims.some((c) => c.pubkey === me))
      .sort((a, b) => b.o.created_at - a.o.created_at)
  }, [board.events, board.ranker, me])

  const settledCount = trades.filter(({ s }) => s.status === 'settled').length

  if (showRelays) return <RelayStatus states={board.relayStates} signer={signer} onClose={() => setShowRelays(false)} />
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div ref={sheet} className="sheet tall" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown} onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h2 id={titleId}>Profile</h2>
          <button className="btn ghost small" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="card">
          <div className="row profile-identity">
            <Name pubkey={me} profiles={board.profiles} showNpub />
            <Copy text={npub} label="Copy npub" />
          </div>
          <div className="stats">
            <div>
              <b>{trades.length}</b>
              <span>trades</span>
            </div>
            <div>
              <b>{settledCount}</b>
              <span>settled</span>
            </div>
            <div>
              <b>{trades.filter(({ s }) => s.status === 'disputed').length}</b>
              <span>disputed</span>
            </div>
          </div>
        </div>

        <h2>History</h2>
        {trades.length === 0 && <div className="empty">No trades yet. Scan a QR or pick one from the board.</div>}
        {trades.map(({ o, s }) => (
          <div key={o.id} className="card history">
            <div className="row">
              <b>{rupees(o.inr)}</b>
              <span className={`status ${s.status}`}>{s.status}</span>
            </div>
            <div className="dim">
              {o.pubkey === me ? 'You posted' : 'You paid'} · {o.payee || o.vpa} · {sats(o.sats)} · {ago(o.created_at)}
            </div>
          </div>
        ))}

        <button ref={relayButton} className="btn ghost" onClick={() => setShowRelays(true)}>Relay connections · {board.relaysUp ?? "…"}/{board.total}</button>
        <button className="btn ghost" disabled={refreshing} onClick={refresh}>{refreshing ? "Refreshing…" : "Refresh profile and follows"}</button>
        {children}
      </div>
    </div>
  )
}
