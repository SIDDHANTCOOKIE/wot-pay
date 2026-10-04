import { useEffect, useState } from 'react'
import { toHexPubkey, npubShort, prefs, restoreSigner } from './identity.js'
import { useBoard } from './useBoard.js'
import { useTokens } from './useTokens.js'
import PayScreen from './PayScreen.jsx'
import BoardScreen from './BoardScreen.jsx'
import ProfileScreen from './ProfileScreen.jsx'
import SigningSettings from './SigningSettings.jsx'
import TrustManager from './TrustManager.jsx'

export default function App() {
  const [signer, setSigner] = useState(null)
  const [signerError, setSignerError] = useState('')
  useEffect(() => {
    let live = true,
      current
    restoreSigner()
      .then((s) => {
        current = s
        if (live) setSigner(s)
        else s.close?.()
      })
      .catch(
        () =>
          live && setSignerError('Saved signer unavailable. Reconnect it or explicitly use the device key.'),
      )
    return () => {
      live = false
      current?.close?.()
    }
  }, [])
  function chooseSigner(next) {
    signer?.close?.()
    setSigner(next)
    setSignerError('')
    setActiveId(null)
  }
  const [tab, setTab] = useState(() =>
    location.hash === '#board' || location.hash.startsWith('#offer/') ? 'board' : 'pay',
  )
  const [activeId, setActiveId] = useState(() => sessionStorage.getItem('wot-pay:active'))
  const [trustInput, setTrustInput] = useState(prefs.trustNpub())
  const [showSettings, setShowSettings] = useState(false)
  const trustRoot = toHexPubkey(prefs.trustNpub()) || signer?.pubkey
  const [trustRevision, setTrustRevision] = useState(0)
  const live = useBoard(trustRoot, signer?.pubkey, trustRevision)
  const cash = useTokens(live.client, signer)
  const board = { ...live, cash }

  useEffect(() => {
    if (!location.hash.startsWith('#offer/') || tab !== 'board') location.hash = tab
  }, [tab])
  useEffect(() => {
    activeId
      ? sessionStorage.setItem('wot-pay:active', activeId)
      : sessionStorage.removeItem('wot-pay:active')
  }, [activeId])

  const usingOwnGraph = trustRoot === signer?.pubkey

  if (!signer)
    return (
      <main className="app">
        <h1>Nostr sign-in</h1>
        <p role="status">{signerError || 'Restoring your signer…'}</p>
        {signerError && <SigningSettings signer={null} onSigner={chooseSigner} />}
      </main>
    )

  return (
    <div className="app">
      <header>
        <div className="brand">
          wot<span>·</span>pay
        </div>
        <button className="who" onClick={() => setShowSettings(true)}>
          <span
            className={`dot ${board.relaysUp === 0 ? 'down' : ''}`}
            title={`${board.relaysUp ?? '…'}/${board.total} relays`}
          />
          {npubShort(signer.pubkey)}
        </button>
      </header>

      {usingOwnGraph && !showSettings && (
        <button className="nudge" onClick={() => setShowSettings(true)}>
          Add your npub so the board knows who you trust
          <span className="go">→</span>
        </button>
      )}

      <main>
        {tab === 'pay' ? (
          <PayScreen board={board} signer={signer} activeId={activeId} setActiveId={setActiveId} />
        ) : (
          <BoardScreen board={board} signer={signer} />
        )}
      </main>

      <nav className="tabs">
        <button className={tab === 'pay' ? 'on' : ''} onClick={() => setTab('pay')}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M1.5 5V2.5a1 1 0 0 1 1-1H5M11 1.5h2.5a1 1 0 0 1 1 1V5M14.5 11v2.5a1 1 0 0 1-1 1H11M5 14.5H2.5a1 1 0 0 1-1-1V11M4.5 8h7" />
          </svg>
          Scan &amp; post
        </button>
        <button className={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <circle cx="8" cy="8" r="1.5" />
            <circle cx="8" cy="8" r="4" opacity="0.6" />
            <circle cx="8" cy="8" r="6.5" opacity="0.35" />
          </svg>
          Board
        </button>
      </nav>

      {showSettings && (
        <ProfileScreen board={board} signer={signer} onClose={() => setShowSettings(false)}>
          <h2>Your web of trust</h2>
          <p className="dim">
            Paste the npub you use on Damus or Primal. We read who it follows to rank the board. Nothing is
            posted from it.
          </p>
          <input
            value={trustInput}
            onChange={(e) => setTrustInput(e.target.value)}
            placeholder="npub1…"
            autoCapitalize="none"
            autoCorrect="off"
          />
          <button
            className="btn primary"
            disabled={trustInput && !toHexPubkey(trustInput)}
            onClick={() => {
              prefs.setTrustNpub(trustInput.trim())
              setShowSettings(false)
            }}
          >
            Save
          </button>
          <SigningSettings signer={signer} onSigner={chooseSigner} />
          <TrustManager board={board} signer={signer} onChanged={() => setTrustRevision((r) => r + 1)} />
        </ProfileScreen>
      )}
    </div>
  )
}
