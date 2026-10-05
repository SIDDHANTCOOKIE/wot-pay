import { useEffect, useState } from 'react'

export default function InstallHint() {
  const [prompt, setPrompt] = useState(null)
  const [help, setHelp] = useState(false)
  const [installed, setInstalled] = useState(() => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true)
  useEffect(() => {
    const ready = (e) => { e.preventDefault(); setPrompt(e) }
    const done = () => { setInstalled(true); setPrompt(null) }
    window.addEventListener('beforeinstallprompt', ready)
    window.addEventListener('appinstalled', done)
    return () => { window.removeEventListener('beforeinstallprompt', ready); window.removeEventListener('appinstalled', done) }
  }, [])
  if (installed) return null
  async function install() {
    if (!prompt) { setHelp(!help); return }
    try { await prompt.prompt(); await prompt.userChoice } catch { setHelp(true) }
    finally { setPrompt(null) }
  }
  return <div className="card">
    <button className="btn ghost" onClick={install}>{prompt ? 'Install wot-pay' : 'How to install wot-pay'}</button>
    {help && <p className="dim">Open this site in a regular browser, not private mode. Android Chrome: menu → Install app or Add to Home screen. iPhone Safari: Share → Add to Home Screen, then Open as Web App. The browser decides when an install prompt is available. Installing does not make trading work offline.</p>}
  </div>
}
