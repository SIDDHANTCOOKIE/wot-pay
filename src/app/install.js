const DISMISSED = 'wot-pay:install-dismissed-until'
const SHOWN = 'wot-pay:install-shown'
const THREE_DAYS = 3 * 24 * 60 * 60 * 1000

export function createInstallController({ target, local, session, now = Date.now, standalone = false, ios = false }) {
  let state = { installed: standalone, prompt: null, popup: false, ios }
  const listeners = new Set()
  const read = (store, key) => { try { return store.getItem(key) } catch { return null } }
  const write = (store, key, value) => { try { store.setItem(key, value) } catch {} }
  const update = (next) => { state = { ...state, ...next }; listeners.forEach((fn) => fn(state)) }
  function show() {
    if (state.installed || read(session, SHOWN) || Number(read(local, DISMISSED)) > now()) return
    write(session, SHOWN, '1')
    update({ popup: true })
  }
  const ready = (event) => {
    if (state.installed) return
    event.preventDefault()
    update({ prompt: event })
    show()
  }
  const done = () => update({ installed: true, prompt: null, popup: false })
  target.addEventListener('beforeinstallprompt', ready)
  target.addEventListener('appinstalled', done)
  if (ios && !standalone) show()
  return {
    get: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    dismiss() { write(local, DISMISSED, String(now() + THREE_DAYS)); update({ popup: false }) },
    async install() {
      const event = state.prompt
      if (!event || state.installed) return 'unavailable'
      update({ prompt: null, popup: false }) // A browser event can only be prompted once.
      try {
        await event.prompt()
        const choice = await event.userChoice
        if (choice?.outcome !== 'accepted') write(local, DISMISSED, String(now() + THREE_DAYS))
        return choice?.outcome || 'unavailable'
      } catch { return 'unavailable' }
    },
    close() { target.removeEventListener('beforeinstallprompt', ready); target.removeEventListener('appinstalled', done) },
  }
}

// Listen before React mounts, and retain the event across identity/guest screen changes.
export const installController = typeof window === 'undefined' ? null : createInstallController({
  target: window, local: window.localStorage, session: window.sessionStorage,
  standalone: window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
  ios: /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
})
