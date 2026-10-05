// Calm connectivity display and recovery for relay drops.
// A brief drop (relay reconnect backoff, network switch) shows "connecting",
// not "offline"; a full drop past the grace window triggers one resubscribe,
// which re-opens relays the pool gave up on after an initial failure.
export const OFFLINE_GRACE_MS = 10000
export const RESUBSCRIBE_AFTER_MS = 8000

export function connectivity({ connected, online = true, downSince = null, now = Date.now() }) {
  if (!online) return { relaysUp: 0, resubscribe: false, downSince: null }
  if (connected > 0) return { relaysUp: connected, resubscribe: false, downSince: null }
  const since = downSince ?? now
  const downMs = Math.max(0, now - since)
  return {
    relaysUp: downMs >= OFFLINE_GRACE_MS ? 0 : null,
    resubscribe: downMs >= RESUBSCRIBE_AFTER_MS,
    downSince: since,
  }
}
