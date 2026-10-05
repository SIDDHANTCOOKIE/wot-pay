import { verifyEvent } from 'nostr-tools/pure'

export function profilePicture(input) {
  if (typeof input !== 'string' || input.length > 2048) return ''
  try {
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.username || url.password) return ''
    return url.href
  } catch { return '' }
}
export function readProfiles(events, authors, now = Math.floor(Date.now() / 1000)) {
  const allowed = new Set(authors)
  const latest = new Map()
  for (const event of events) {
    try {
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
