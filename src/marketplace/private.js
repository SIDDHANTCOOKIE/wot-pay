import { wrapEvent, unwrapEvent } from 'nostr-tools/nip17'
import { createWrap } from 'nostr-tools/nip59'
import { getPublicKey, getEventHash, verifyEvent } from 'nostr-tools/pure'
import { parsePrivate } from './protocol.js'

const SUBJECT = 'wot-pay-v3:trade'
export function wrapPrivate(sk, to, signed) {
  const parsed = parsePrivate(signed)
  if (!parsed || signed.pubkey !== getPublicKey(sk) || !/^[0-9a-f]{64}$/.test(to)) throw new Error('Invalid private message or recipient.')
  return wrapEvent(sk, { publicKey: to }, JSON.stringify(signed), SUBJECT)
}
function fromRumor(rumor) {
  if (rumor.kind !== 14 || rumor.tags.find(t => t[0] === 'subject')?.[1] !== SUBJECT) return null
  const signed = JSON.parse(rumor.content)
  return parsePrivate(signed) && signed.pubkey === rumor.pubkey ? signed : null
}
export function openPrivate(sk, wrap) {
  try { return fromRumor(unwrapEvent(wrap, sk)) } catch { return null }
}

// External signers (NIP-07 extension, NIP-46 bunker) build the same NIP-17
// gift wrap using only their own signing and NIP-44, so the user's secret key
// never enters this app. Only the seal needs the user; the outer wrap uses a
// one-time key. nip44: { encrypt(pubkey, text), decrypt(pubkey, text) }.
const TWO_DAYS = 2 * 86400
async function sealAndWrap(signer, nip44, to, content, tags) {
  const rumor = { created_at: Math.ceil(Date.now() / 1000), kind: 14, tags: [['p', to], ...tags], content, pubkey: signer.pubkey }
  rumor.id = getEventHash(rumor)
  const seal = await signer.sign({ kind: 13, content: await nip44.encrypt(to, JSON.stringify(rumor)), created_at: Math.round(Date.now() / 1000 - Math.random() * TWO_DAYS), tags: [] })
  return createWrap(seal, to)
}
export async function wrapPrivateWith(signer, nip44, to, signed) {
  if (!parsePrivate(signed) || signed.pubkey !== signer.pubkey || !/^[0-9a-f]{64}$/.test(to)) throw new Error('Invalid private message or recipient.')
  return sealAndWrap(signer, nip44, to, JSON.stringify(signed), [['subject', SUBJECT]])
}

// A plain NIP-17 chat message, so the person's usual Nostr app shows it even
// while wot-pay is closed. It has no trade subject, so wot-pay ignores it.
const noticeText = text => { if (typeof text !== 'string' || !text || text.length > 500) throw new Error('Invalid notice.'); return text }
export function wrapNotice(sk, to, text) {
  return wrapEvent(sk, { publicKey: to }, noticeText(text))
}
export async function wrapNoticeWith(signer, nip44, to, text) {
  return sealAndWrap(signer, nip44, to, noticeText(text), [])
}
export async function openPrivateWith(nip44, wrap) {
  try {
    if (wrap.kind !== 1059 || !verifyEvent(JSON.parse(JSON.stringify(wrap)))) return null
    const seal = JSON.parse(await nip44.decrypt(wrap.pubkey, wrap.content))
    if (seal.kind !== 13 || !verifyEvent(seal)) return null
    const rumor = JSON.parse(await nip44.decrypt(seal.pubkey, seal.content))
    // The seal signer must be the claimed author, or anyone could impersonate.
    if (rumor.pubkey !== seal.pubkey || getEventHash(rumor) !== rumor.id) return null
    return fromRumor(rumor)
  } catch { return null }
}
export function inboxRelays(events, owner) {
  const latest = events.filter(e => {
    try { return e.kind === 10050 && e.pubkey === owner && e.created_at <= Math.floor(Date.now() / 1000) + 60 && verifyEvent(JSON.parse(JSON.stringify(e))) } catch { return false }
  }).sort((a,b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0]
  return [...new Set((latest?.tags || []).filter(t => t[0] === 'relay').map(t => t[1]).filter(url => {
    try { const u = new URL(url); return u.protocol === 'wss:' && !u.username && !u.password && !u.hash } catch { return false }
  }))].slice(0, 8)
}

export async function deliverPrivate({ client, signer, vault, to, signed }) {
  // Save before discovery: an unavailable inbox must not erase a pending send.
  const id = `outbox:${signed.id}:${to}`
  let operation = await vault.read(id)
  if (!operation) operation = await vault.write(id, { wrap: await signer.wrapPrivate(to, signed), to, signed, status: 'pending' })
  if (operation.value.status === 'delivered') return operation
  const relays = inboxRelays(await client.queryIdentity({ kinds: [10050], authors: [to] }), to)
  if (!relays.length) throw new Error('Recipient has not enabled a Nostr private inbox. Your message is saved for retry.')
  await client.publishTo(relays, operation.value.wrap)
  return vault.write(id, { ...operation.value, status: 'delivered' }, operation.revision)
}
