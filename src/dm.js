// Cashu tokens move peer to peer as NIP-17 DMs: a kind 14 message, sealed and
// gift wrapped (kind 1059). Relays only ever see ciphertext.
import { wrapEvent, unwrapEvent } from 'nostr-tools/nip17'
import { getPublicKey } from 'nostr-tools/pure'
import { getTokenMetadata } from '@cashu/cashu-ts'
import { TOKEN_STRING } from './fence.js'

export const GIFT_WRAP = 1059
const SUBJECT = 'wot-pay:'
const HEX64 = /^[0-9a-f]{64}$/

// Pull a Cashu token out of pasted text. Returns { token, mint, amount, unit } or null.
export function readToken(text) {
  const m = String(text || '').match(TOKEN_STRING)
  if (!m) return null
  try {
    const meta = getTokenMetadata(m[0])
    const amount = Number(meta.amount)
    if (!Number.isInteger(amount) || amount <= 0) return null
    return { token: m[0], mint: meta.mint, amount, unit: meta.unit || 'sat' }
  } catch {
    return null
  }
}

// Gift wraps for the recipient and a copy for the sender, both tied to one offer.
export function wrapToken({ sk, to, token, offerId }) {
  if (!readToken(token)) throw new Error('not a Cashu token')
  if (!HEX64.test(to || '') || !HEX64.test(offerId || '')) throw new Error('bad recipient or offer id')
  const subject = SUBJECT + offerId
  return [to, getPublicKey(sk)].map((pk) => wrapEvent(sk, { publicKey: pk }, token, subject))
}

// Open a gift wrap addressed to us. Returns null for anything that isn't a token DM.
export function openToken(wrap, sk) {
  let rumor
  try {
    rumor = unwrapEvent(wrap, sk)
  } catch {
    return null
  }
  const subject = rumor.tags.find((t) => t[0] === 'subject')?.[1] || ''
  const offerId = subject.startsWith(SUBJECT) ? subject.slice(SUBJECT.length) : null
  const t = readToken(rumor.content)
  if (!offerId || !HEX64.test(offerId) || !t) return null
  return { id: wrap.id, from: rumor.pubkey, offerId, created_at: rumor.created_at, ...t }
}

// Problems with a token for a given offer, as short strings. Empty = fine.
export function tokenIssues(t, { sats, mint } = {}) {
  const out = []
  if (t.unit !== 'sat') out.push(`in ${t.unit}, not sats`)
  if (sats && t.amount < sats) out.push(`${(sats - t.amount).toLocaleString('en-IN')} sats short`)
  if (mint && t.mint.replace(/\/$/, '') !== mint.replace(/\/$/, '')) out.push('not the mint they asked for')
  return out
}
