import { useState } from 'react'
import {
  importLocalKey,
  exportLocalKey,
  localSigner,
  extensionSigner,
  connectBunker,
  saveSignerChoice,
  hasLocalKey,
} from './identity.js'

export default function SigningSettings({ signer, onSigner, onSignOut }) {
  const [secret, setSecret] = useState(''),
    [bunker, setBunker] = useState('')
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  async function change(get) {
    setBusy(true)
    setError('')
    try {
      const next = await get()
      if (!next) throw new Error('No Nostr extension found')
      onSigner(next)
      setSecret('')
      setBunker('')
    } catch {
      setError('Could not change signer. Check the key or connection, and try again. Nothing was published.')
    } finally {
      setBusy(false)
    }
  }
  function download() {
    if (
      !window.confirm(
        'This downloads your device private key. Anyone with this file can sign as you and read your token DMs. Keep it offline and never share it. Continue?',
      )
    )
      return
    try {
      const url = URL.createObjectURL(new Blob([exportLocalKey()], { type: 'text/plain' }))
      const a = document.createElement('a')
      a.href = url
      a.download = 'wot-pay-device-key.txt'
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch {
      setError('Could not export the device key.')
    }
  }
  return (
    <>
      <h2>Nostr signing</h2>
      <p className="dim">
        Current: {signer?.kind || 'unavailable'}. Your npub is public; only a signer can log in and post.
      </p>
      <p className="fine">
        Import stays on this browser, in plaintext storage. Never paste a primary wallet key. Changing signer
        changes your trading identity.
      </p>
      {signer && onSignOut && (
        <>
          <button className="btn ghost" disabled={busy} onClick={onSignOut}>
            Sign out
          </button>
          <p className="fine">
            Sign out stops using this identity here. Your device key stays in this browser so you can
            return with "Use device key". Export it before clearing browser data, or you will lose
            access to this identity and its private DMs. Posted offers and claims stay on relays;
            signing out does not cancel them or settle a trade. A remote signer must be connected again.
          </p>
        </>
      )}
      <input
        className="input"
        type="password"
        aria-label="Import nsec"
        placeholder="nsec1… (device only)"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <button
        className="btn ghost"
        disabled={busy || !secret.trim()}
        onClick={() => {
          if (
            window.confirm(
              'Replace this device signing key? Back up the old key first or you may lose its private DMs.',
            )
          )
            change(() => importLocalKey(secret))
        }}
      >
        Import nsec locally
      </button>
      <button className="btn ghost" disabled={busy || !hasLocalKey()} onClick={download}>
        Export device key
      </button>
      <button
        className="btn ghost"
        disabled={busy}
        onClick={() =>
          change(async () => {
            const s = await extensionSigner()
            if (s) saveSignerChoice('extension')
            return s
          })
        }
      >
        Use Nostr extension
      </button>
      <button
        className="btn ghost"
        disabled={busy || !hasLocalKey()}
        onClick={() =>
          change(() => {
            saveSignerChoice('local')
            return localSigner()
          })
        }
      >
        Use device key
      </button>
      <input
        className="input"
        type="password"
        aria-label="Bunker connection"
        placeholder="bunker://…"
        value={bunker}
        onChange={(e) => setBunker(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <button
        className="btn ghost"
        disabled={busy || !bunker.trim()}
        onClick={() => change(() => connectBunker(bunker))}
      >
        {busy ? 'Connecting…' : 'Connect remote signer (NIP-46)'}
      </button>
      <p className="dim">
        Remote signer uses a bunker link from your signer app. Approve the connection there. Extension and
        bunker modes currently support public events only; use Lightning, not token DMs.
      </p>
      {error && (
        <p className="hint warn" role="alert">
          {error}
        </p>
      )}
    </>
  )
}
