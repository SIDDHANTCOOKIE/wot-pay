import { useEffect, useState } from 'react'
import { toHexPubkey, prefs, restoreSigner, signOut } from './identity.js'
import { useBoard } from './useBoard.js'
import { useTokens } from './useTokens.js'
import PayScreen from './PayScreen.jsx'
import BoardScreen from './BoardScreen.jsx'
import ProfileScreen from './ProfileScreen.jsx'
import SigningSettings from './SigningSettings.jsx'
import TrustManager from './TrustManager.jsx'
import IdentityChoice from './IdentityChoice.jsx'
import InstallHint from './InstallHint.jsx'
import { Name } from './ui.jsx'

export default function App() {
  const [signer, setSigner] = useState(null)
  const [signerError, setSignerError] = useState('')
  const [restoring, setRestoring] = useState(true)
  const [guest, setGuest] = useState(false)
  useEffect(() => {
    let live = true,
      current
    restoreSigner()
      .then((s) => {
        current = s
        if (live) setSigner(s)
        else s?.close?.()
      })
      .catch(
        () =>
          live && setSignerError('Saved signer unavailable. Reconnect it or explicitly use the device key.'),
      )
      .finally(() => live && setRestoring(false))
    return () => {
      live = false
      current?.close?.()
    }
  }, [])
  function chooseSigner(next) {
    signer?.close?.()
    setSigner(next)
    setGuest(false)
    setSignerError('')
    setActiveId(null)
    setShowSettings(false)
  }
  function leaveIdentity() {
    if (!window.confirm('Sign out here? Posted offers and claims remain active. Finish or cancel them first if needed. Your device key will be kept in this browser.')) return
    signOut()
    signer?.close?.()
    setSigner(null)
    setGuest(false)
    setSignerError('')
    setActiveId(null)
    setShowSettings(false)
  }
  const [tab, setTab] = useState(() =>
    location.hash === '#board' || location.hash.startsWith('#offer/') ? 'board' : 'pay',
  )
  const [activeId, setActiveId] = useState(() => sessionStorage.getItem('wot-pay:active'))
  const [trustInput, setTrustInput] = useState(prefs.trustNpub())
  const [showSettings, setShowSettings] = useState(false)
  const trustRoot = signer ? toHexPubkey(prefs.trustNpub()) || signer.pubkey : undefined
  const [trustRevision, setTrustRevision] = useState(0)
  const live = useBoard(trustRoot, signer?.pubkey, trustRevision)
  const cash = useTokens(live.client, signer)
  const board = { ...live, cash, publish: async (event) => {
    if (!signer) throw new Error('Choose a signing identity before publishing.')
    return live.publish(event)
  } }

  useEffect(() => {
    if (!location.hash.startsWith('#offer/') || tab !== 'board') location.hash = tab
  }, [tab])
  useEffect(() => {
    activeId
      ? sessionStorage.setItem('wot-pay:active', activeId)
      : sessionStorage.removeItem('wot-pay:active')
  }, [activeId])


  function requireIdentity() { setGuest(false); setShowSettings(false) }
  if (!signer && !guest)
    return <div className="app"><main className="screen">
      {restoring ? <p role="status">Restoring your signer…</p> :
        <IdentityChoice error={signerError} onSigner={chooseSigner} onGuest={() => { setGuest(true); setTab('board') }} />}
      <InstallHint />
    </main></div>

  return (
    <div className="app">
      <header>
        <div className="brand">
          wot<span>·</span>pay
        </div>
        <button className="who" onClick={() => signer ? setShowSettings(true) : requireIdentity()}>
          <span
            className={`dot ${board.relaysUp === 0 ? 'down' : ''}`}
            title={`${board.relaysUp ?? '…'}/${board.total} relays`}
          />
          {signer ? <Name pubkey={signer.pubkey} profiles={board.profiles} showNpub /> : 'Guest · choose identity'}
        </button>
      </header>

      <main>
        <InstallHint hidden={showSettings} />
        {guest && <div className="card"><h2>Guest demo mode</h2><p className="dim">Read-only demo: the board shows public offers. Trust ranking uses follow lists and trade claims, not payment proof. With no trust graph selected, offers are unranked; strangers may not send sats.</p><button className="btn ghost" onClick={requireIdentity}>Choose an identity to trade</button></div>}
        {tab === 'pay' ? (
          <PayScreen board={board} signer={signer} activeId={activeId} setActiveId={setActiveId} />
        ) : (
          <BoardScreen board={board} signer={signer} onRequireIdentity={requireIdentity} />
        )}
      </main>

      <nav className="tabs">
        <button className={tab === 'pay' ? 'on' : ''} onClick={() => signer ? setTab('pay') : requireIdentity()}>
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

      {showSettings && signer && (
        <ProfileScreen board={board} signer={signer} onClose={() => setShowSettings(false)}>
          <h2>Your web of trust</h2>
          <p className="dim">Your signed-in identity's follows are used automatically.</p>
          <details className="identity-options"><summary>Use another trust graph (optional)</summary>
          <p className="dim">
            Override the graph with a public npub. Leave it empty to use your signed-in identity. Nothing is posted from this field.
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
          </details>
          <SigningSettings signer={signer} onSigner={chooseSigner} onSignOut={leaveIdentity} />
          <TrustManager board={board} signer={signer} onChanged={() => setTrustRevision((r) => r + 1)} />
        </ProfileScreen>
      )}
    </div>
  )
}
