import { describe, expect, it, vi } from 'vitest'
import { createInstallController } from './install.js'
const store = () => { const map = new Map(); return { getItem: (k) => map.get(k) || null, setItem: (k, v) => map.set(k, v) } }
function setup(options = {}) {
  const target = new EventTarget(), local = options.local || store(), session = options.session || store()
  return { target, local, session, c: createInstallController({ target, local, session, now: () => 1000, ...options }) }
}
function ready(target, outcome = 'accepted') {
  const e = new Event('beforeinstallprompt', { cancelable: true }); e.prompt = vi.fn(async () => {}); e.userChoice = Promise.resolve({ outcome }); target.dispatchEvent(e); return e
}
describe('native install suggestion', () => {
  it('retains an early browser event and prompts only once even for concurrent taps', async () => {
    const { target, c } = setup(); const e = ready(target)
    expect(e.defaultPrevented).toBe(true); expect(c.get().popup).toBe(true)
    const first = c.install(); expect(await c.install()).toBe('unavailable'); expect(await first).toBe('accepted'); expect(e.prompt).toHaveBeenCalledTimes(1)
  })
  it('shows once per session but keeps direct install available', () => {
    const { target, c } = setup(); ready(target); c.dismiss(); ready(target)
    expect(c.get().popup).toBe(false); expect(c.get().prompt).toBeTruthy()
  })
  it('remembers dismissal for three days across new sessions', () => {
    const a = setup(); ready(a.target); a.c.dismiss()
    const b = setup({ local: a.local }); ready(b.target); expect(b.c.get().popup).toBe(false)
    const d = setup({ local: a.local, now: () => 1000 + 4 * 86400000 }); ready(d.target); expect(d.c.get().popup).toBe(true)
  })
  it('hides suggestions once installed and never prompts standalone', () => {
    const a = setup(); ready(a.target); a.target.dispatchEvent(new Event('appinstalled')); expect(a.c.get().installed).toBe(true); expect(a.c.get().popup).toBe(false)
    const b = setup({ standalone: true }); ready(b.target); expect(b.c.get().prompt).toBeNull(); expect(b.c.get().popup).toBe(false)
  })
  it('offers only a manual hint on iOS and cannot silently install', async () => {
    const { c } = setup({ ios: true }); expect(c.get().popup).toBe(true); expect(c.get().prompt).toBeNull(); expect(await c.install()).toBe('unavailable')
  })
  it('backs off when the native dialog is dismissed', async () => {
    const a = setup(); ready(a.target, 'dismissed'); expect(await a.c.install()).toBe('dismissed')
    const b = setup({ local: a.local }); ready(b.target); expect(b.c.get().popup).toBe(false)
  })
})
