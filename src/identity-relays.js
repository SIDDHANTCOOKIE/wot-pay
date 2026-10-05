import { verifyEvent } from 'nostr-tools/pure'
import { DEFAULT_RELAYS } from './kinds.js'
export const IDENTITY_RELAYS = [...DEFAULT_RELAYS, 'wss://purplepag.es', 'wss://nostr-01.yakihonne.com']
export function safeRelay(input) {
  try {
    const u = new URL(input)
    if (u.protocol !== 'wss:' || u.username || u.password || u.hash || (u.port && u.port !== '443')) return null
    const h = u.hostname.toLowerCase()
    // Public DNS names only. Do not connect to local/IP destinations from relay hints.
    if (!h.includes('.') || h.endsWith('.local') || h.endsWith('.localhost') || h.endsWith('.internal') || h.includes(':') || /^[\d.]+$/.test(h)) return null
    return u.href
  } catch { return null }
}
export function writeRelays(events, owner, now = Math.floor(Date.now() / 1000)) {
  const valid = events.filter(e => {
    try { return e.kind === 10002 && e.pubkey === owner && e.created_at <= now + 60 && verifyEvent({ id: e.id, sig: e.sig, pubkey: e.pubkey, kind: e.kind, created_at: e.created_at, tags: e.tags, content: e.content }) } catch { return false }
  }).sort((a,b) => b.created_at-a.created_at || a.id.localeCompare(b.id))
  return [...new Set((valid[0]?.tags || []).filter(t => t[0] === 'r' && (!t[2] || t[2] === 'write')).map(t => safeRelay(t[1])).filter(Boolean))].slice(0, 6)
}
