import { useState } from 'react'
import { createLocalIdentity, hasLocalKey, localSigner, saveSignerChoice } from './identity.js'
import SigningSettings from './SigningSettings.jsx'

export default function IdentityChoice({ onSigner, onGuest, error = '' }) {
  const [problem, setProblem] = useState('')
  function device() {
    try {
      const next = hasLocalKey() ? localSigner() : createLocalIdentity()
      saveSignerChoice('local')
      onSigner(next)
    } catch (e) { setProblem(e.message) }
  }
  return <section className="screen identity-entry">
    <div className="brand identity-brand">wot<span>·</span>pay</div>
    <h1>Your key. Your network.</h1>
    <p className="lede">Sign in with Nostr to trade with your network.</p>
    {(error || problem) && <p role="alert" className="hint warn">{error || problem}</p>}
    <button className="btn primary" onClick={device}>{hasLocalKey() ? 'Use saved device key' : 'Create a new key'}</button>
    <p className="fine">Device keys stay in this browser. Back up before trading.</p>
    <details className="identity-options"><summary>Use an existing Nostr identity</summary>
      <SigningSettings signer={null} onSigner={onSigner} />
    </details>
    <button className="identity-guest" onClick={onGuest}>Explore as guest</button>
    <p className="fine">Read-only. No key needed.</p>
  </section>
}
