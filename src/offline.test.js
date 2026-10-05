import { describe, it, expect } from 'vitest'
import { connectivity, OFFLINE_GRACE_MS, RESUBSCRIBE_AFTER_MS } from './offline.js'

describe('connectivity', () => {
  it('shows the real count while any relay is up', () => {
    expect(connectivity({ connected: 2, now: 1000 })).toEqual({ relaysUp: 2, resubscribe: false, downSince: null })
  })
  it('shows connecting, not offline, during a short drop', () => {
    const r = connectivity({ connected: 0, now: 5000 })
    expect(r.relaysUp).toBeNull()
    expect(r.resubscribe).toBe(false)
    expect(r.downSince).toBe(5000)
  })
  it('resubscribes after the recovery window and keeps showing connecting until the grace ends', () => {
    const r = connectivity({ connected: 0, downSince: 0, now: RESUBSCRIBE_AFTER_MS + 1 })
    expect(r.resubscribe).toBe(true)
    expect(r.relaysUp).toBeNull()
  })
  it('shows offline only after the grace window with no relays', () => {
    const r = connectivity({ connected: 0, downSince: 0, now: OFFLINE_GRACE_MS })
    expect(r.relaysUp).toBe(0)
    expect(r.resubscribe).toBe(true)
  })
  it('never resubscribes when the device itself is offline', () => {
    expect(connectivity({ connected: 0, online: false, now: 99999 }).resubscribe).toBe(false)
    expect(connectivity({ connected: 0, online: false, now: 99999 }).relaysUp).toBe(0)
  })
  it('resets the drop clock when a relay returns', () => {
    expect(connectivity({ connected: 1, downSince: 123, now: 200 }).downSince).toBeNull()
  })
})
