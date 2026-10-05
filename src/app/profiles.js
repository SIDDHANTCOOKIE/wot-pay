import { verifyEvent } from 'nostr-tools/pure'

export function profilePicture(input) {
  if (typeof input !== 'string' || input.length > 2048) return ''
  try {
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.username || url.password) return ''
    const host = url.hostname.toLowerCase()
    if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.internal') || host.includes(':') || /^[\d.]+$/.test(host)) return ''
    return url.href
  } catch { return '' }
}
export function readProfiles(events, authors, now = Math.floor(Date.now() / 1000)) {
  const allowed = new Set(authors)
  const latest = new Map()
  for (const event of events) {
    try {
      if (typeof event.content !== 'string' || event.content.length > 16000 || !Array.isArray(event.tags) || event.tags.length > 2000 || !event.tags.every(t => Array.isArray(t) && t.length <= 8 && t.every(v => typeof v === 'string' && v.length <= 2048))) continue
      if (event.kind !== 0 || !allowed.has(event.pubkey) || event.created_at > now + 60 || !verifyEvent({ id: event.id, sig: event.sig, pubkey: event.pubkey, kind: event.kind, created_at: event.created_at, tags: event.tags, content: event.content })) continue
      const old = latest.get(event.pubkey)
      if (!old || event.created_at > old.created_at || (event.created_at === old.created_at && event.id < old.id)) latest.set(event.pubkey, event)
    } catch { continue }
  }
  const out = {}
  for (const [pubkey, event] of latest) {
    try {
      const data = JSON.parse(event.content)
      const candidate = [data.display_name, data.name].find((v) => typeof v === 'string' && v.trim() && v.length <= 256)
      out[pubkey] = { name: candidate?.trim() || '', picture: profilePicture(data.picture) }
    } catch { out[pubkey] = { name: '', picture: '' } }
  }
  return out
}

// Bound identity reads even for large follow lists. Missing metadata keeps the npub.
export const PROFILE_LIMIT = 500
export const PROFILE_CHUNK = 100
export async function loadProfiles(client, authors, { owner, maxAuthors = PROFILE_LIMIT } = {}) {
  const wanted = [...new Set(authors)].filter(pk => typeof pk === 'string' && /^[0-9a-f]{64}$/.test(pk)).slice(0, Math.min(PROFILE_LIMIT, Math.max(0, maxAuthors)))
  const batches = []
  for (let i = 0; i < wanted.length; i += PROFILE_CHUNK) batches.push(wanted.slice(i, i + PROFILE_CHUNK))
  const out = {}
  async function worker() {
    while (batches.length) {
      const batch = batches.shift()
      try {
        const events = await client.queryIdentity({ kinds: [0], authors: batch }, { discover: true, relayOwner: owner, maxWait: 3000 })
        Object.assign(out, readProfiles(events, batch))
      } catch { /* a failed relay query must not hide the follow list */ }
    }
  }
  await Promise.all([worker(), worker()])
  return out
}
