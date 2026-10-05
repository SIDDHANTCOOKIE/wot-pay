import { useState } from 'react'
import { createLocalIdentity, hasLocalKey, localSigner, saveSignerChoice } from './identity.js'
import SigningSettings from './SigningSettings.jsx'

export default function IdentityChoice({ onSigner, onGuest, error = '' }) {
  const [existing, setExisting] = useState(false)
  const [problem, setProblem] = useState('')
  function device() {
    try {
      const next = hasLocalKey() ? localSigner() : createLocalIdentity()
      saveSignerChoice('local')
      onSigner(next)
    } catch (e) { setProblem(e.message) }
  }
  return <section className="screen">
    <h1>How would you like to use wot-pay?</h1>
    <p className="lede">Choose a signing identity to trade, or explore without one.</p>
    {(error || problem) && <p role="alert" className="hint warn">{error || problem}</p>}
    <button className="btn primary" onClick={device}>{hasLocalKey() ? 'Use saved device key' : 'Create a new key'}</button>
    <p className="fine">A new key is stored only in this browser. Export a backup before trading. It is not your existing Nostr account.</p>
    <button className="btn ghost" onClick={() => setExisting(!existing)}>I already have a key</button>
    {existing && <SigningSettings signer={null} onSigner={onSigner} />}
    <button className="btn ghost" onClick={onGuest}>Browse as guest</button>
    <p className="fine">Demo mode, read-only: view public offers and learn how trust works. No key is created. Posting, claiming and settlement need a signer.</p>
  </section>
}
