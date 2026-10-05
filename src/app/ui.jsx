import { useEffect, useRef, useState } from 'react'
import { exposureWarning } from './exposure.js'
import Orbit, { tone, where } from './Orbit.jsx'
import { npubShort } from './identity.js'

export function Name({ pubkey, names, profiles, you, showNpub = false }) {
  const profile = profiles?.[pubkey]
  const [broken, setBroken] = useState('')
  const short = npubShort(pubkey)
  const name = profile?.name || names?.[pubkey] || short
  const picture = profile?.picture
  return <span className="identity-label" title={short}>
    {picture && broken !== picture ? <img className="identity-avatar" src={picture} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(picture)} /> :
      <span className="identity-avatar placeholder" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>}
    <span className="identity-copy"><span className="name">{name}{pubkey === you && name !== short ? ' (you)' : ''}</span>{showNpub && name !== short && <span className="identity-npub">{short}</span>}</span>
  </span>
}

export function ExposureWarning({ trust, loading }) {
  const message = exposureWarning(trust, loading)
  return message ? <p className="hint warn">{message}</p> : null
}

// Trust at a glance: a small orbit plus where they sit and their record.
export function TrustBadge({ trust, pubkey }) {
  if (!trust) return null
  const { settles, disputes } = trust
  return (
    <span className={`badge ${tone(trust)}`}>
      <Orbit trust={trust} pubkey={pubkey} size={22} live={false} />
      {where(trust)}
      {settles > 0 && <span className="rec"> · {fmt(settles)} settled</span>}
      {disputes > 0 && <span className="rec"> · {fmt(disputes)} disputed</span>}
    </span>
  )
}

// Short label for a mint URL: host plus path, no scheme.
export function mintName(url) {
  try {
    const u = new URL(url)
    return (u.host + u.pathname).replace(/\/$/, '')
  } catch {
    return url
  }
}

export function MintChip({ mint }) {
  if (!mint) return null
  return <span className="chip">ecash · {mintName(mint)}</span>
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

export function Copy({ text, label = 'Copy' }) {
  const [state, setState] = useState('idle')
  const copying = useRef(false)
  useEffect(() => {
    if (state === 'idle' || state === 'copying') return
    const reset = setTimeout(() => setState('idle'), 1800)
    return () => clearTimeout(reset)
  }, [state])

  async function copy() {
    if (copying.current) return
    copying.current = true
    setState('copying')
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(text)
      setState('copied')
    } catch {
      setState('failed')
    } finally {
      copying.current = false
    }
  }

  return (
    <button type="button" className="btn ghost small" onClick={copy} disabled={state === 'copying'} aria-busy={state === 'copying'} aria-live="polite">
      {state === 'copying' ? 'Copying…' : state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy' : label}
    </button>
  )
}
