import { useEffect, useState } from 'react'
import { installController } from './install.js'

export default function InstallHint({ hidden = false }) {
  const [state, setState] = useState(() => installController.get())
  const [help, setHelp] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => installController.subscribe(setState), [])
  if (hidden || state.installed) return null
  async function install() {
    if (busy) return
    setBusy(true)
    const outcome = await installController.install()
    if (outcome === 'unavailable') setHelp(true)
    setBusy(false)
  }
  if (state.popup) return <aside className="install-toast" aria-label="Install wot-pay" role="region">
    <div className="row"><strong>Install wot-pay</strong><button className="install-dismiss" aria-label="Dismiss install suggestion" onClick={() => installController.dismiss()}>Not now</button></div>
    <p>{state.prompt ? 'Tap Install, then confirm in your browser.' : 'Safari: Share → Add to Home Screen → Open as Web App.'}</p>
    {state.prompt && <button className="btn primary" disabled={busy} onClick={install}>Install</button>}
  </aside>
  return <div className="install-inline">
    <button className="install-link" disabled={busy} onClick={install}>Install app</button>
    {help && <p className="fine">{state.ios ? 'Safari: Share → Add to Home Screen → Open as Web App.' : 'Chrome has not offered a native install prompt. Try a regular tab, then browser menu → Install app.'} The browser asks you to confirm.</p>}
  </div>
}
