import { wrapEvent, unwrapEvent } from 'nostr-tools/nip17'
import { getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { parsePrivate } from './protocol.js'

const SUBJECT = 'wot-pay-v3:trade'
export function wrapPrivate(sk, to, signed) {
  const parsed = parsePrivate(signed)
  if (!parsed || signed.pubkey !== getPublicKey(sk) || !/^[0-9a-f]{64}$/.test(to)) throw new Error('Invalid private message or recipient.')
  return wrapEvent(sk, { publicKey: to }, JSON.stringify(signed), SUBJECT)
}
export function openPrivate(sk, wrap) {
  try {
    const rumor = unwrapEvent(wrap, sk)
    if (rumor.kind !== 14 || rumor.tags.find(t => t[0] === 'subject')?.[1] !== SUBJECT) return null
    const signed = JSON.parse(rumor.content)
    return parsePrivate(signed) && signed.pubkey === rumor.pubkey ? signed : null
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
  if (!operation) operation = await vault.write(id, { wrap: signer.wrapPrivate(to, signed), to, signed, status: 'pending' })
  if (operation.value.status === 'delivered') return operation
  const relays = inboxRelays(await client.queryIdentity({ kinds: [10050], authors: [to] }), to)
  if (!relays.length) throw new Error('Recipient has not enabled a Nostr private inbox. Your message is saved for retry.')
  await client.publishTo(relays, operation.value.wrap)
  return vault.write(id, { ...operation.value, status: 'delivered' }, operation.revision)
}
