import { useEffect, useState } from 'react'
import { localSigner, extensionSigner, toHexPubkey, npubShort, prefs } from './identity.js'
import { useBoard } from './useBoard.js'
import PayScreen from './PayScreen.jsx'
import BoardScreen from './BoardScreen.jsx'
import ProfileScreen from './ProfileScreen.jsx'

export default function App() {
  const [signer, setSigner] = useState(localSigner)
  const [tab, setTab] = useState(() => (location.hash === '#board' ? 'board' : 'pay'))
  const [activeId, setActiveId] = useState(() => sessionStorage.getItem('wot-upi:active'))
  const [trustInput, setTrustInput] = useState(prefs.trustNpub())
  const [showSettings, setShowSettings] = useState(false)
  const trustRoot = toHexPubkey(prefs.trustNpub()) || signer.pubkey
  const board = useBoard(trustRoot, signer.pubkey)

  useEffect(() => {
    location.hash = tab
  }, [tab])
  useEffect(() => {
    activeId ? sessionStorage.setItem('wot-upi:active', activeId) : sessionStorage.removeItem('wot-upi:active')
  }, [activeId])

  const usingOwnGraph = trustRoot === signer.pubkey

  return (
    <div className="app">
      <header>
        <div className="brand">
          wot<span>·</span>upi
        </div>
        <button className="who" onClick={() => setShowSettings(true)}>
          <span className="dot" />
          {npubShort(signer.pubkey)}
        </button>
      </header>

      {usingOwnGraph && !showSettings && (
        <button className="nudge" onClick={() => setShowSettings(true)}>
          Add your npub so the board knows who you trust →
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
          <span className="icon">⌗</span>Scan &amp; post
        </button>
        <button className={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>
          <span className="icon">☰</span>Board
        </button>
      </nav>

      {showSettings && (
        <ProfileScreen board={board} signer={signer} onClose={() => setShowSettings(false)}>
          <h2>Your web of trust</h2>
          <p className="dim">
            Paste the npub you use on Damus or Primal. We read who it follows to rank the board. Nothing is posted
            from it.
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
          <h2>Signing key</h2>
          <p className="dim">
            {signer.kind === 'local'
              ? 'A key made on this device signs your offers and stamps.'
              : 'Your browser extension signs everything.'}
          </p>
          {signer.kind === 'local' && window.nostr && (
            <button className="btn ghost" onClick={async () => setSigner((await extensionSigner()) || signer)}>
              Use my Nostr extension
            </button>
          )}
        </ProfileScreen>
      )}
    </div>
  )
}
