import { npubShort } from './identity.js'

export function Name({ pubkey, names, you }) {
  if (pubkey === you) return <span className="name">you</span>
  return <span className="name">{names?.[pubkey] || npubShort(pubkey)}</span>
}

// Trust at a glance: how far away, how many settled trades, any disputes.
export function TrustBadge({ trust }) {
  if (!trust) return null
  const { hops, settles, disputes } = trust
  const tone = disputes > 0 ? 'bad' : hops === null ? 'far' : hops <= 1 ? 'good' : 'ok'
  const where = hops === null ? 'outside your web' : hops === 0 ? 'you' : hops === 1 ? 'you follow' : `${hops} hops`
  return (
    <span className={`badge ${tone}`}>
      <span className="dot" />
      {where}
      {settles > 0 && <> · {fmt(settles)} settled</>}
      {disputes > 0 && <> · {fmt(disputes)} disputed</>}
    </span>
  )
}

const fmt = (n) => (Number.isInteger(n) ? n : n.toFixed(1))

export const rupees = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
export const sats = (n) => `${Number(n).toLocaleString('en-IN')} sats`

export function ago(ts) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

export function Steps({ at, labels }) {
  return (
    <ol className="steps">
      {labels.map((l, i) => (
        <li key={l} className={i < at ? 'done' : i === at ? 'now' : ''}>
          <span>{l}</span>
        </li>
      ))}
    </ol>
  )
}

export function Copy({ text, label }) {
  return (
    <button
      className="btn ghost small"
      onClick={(e) => {
        navigator.clipboard?.writeText(text)
        e.currentTarget.textContent = 'Copied'
      }}
    >
      {label || 'Copy'}
    </button>
  )
}
