import { inboxRelays } from './marketplace/private.js'

// Nudges people through their usual Nostr app (an ordinary NIP-17 chat
// message) when something needs them, because wot-pay cannot run in the
// background. Notices name the step only: never a UPI ID, merchant or amount.
// They are best-effort, never block a trade step, and are not retried.
const KEY = 'wot-pay:nostr-notices'
const HEX64 = /^[0-9a-f]{64}$/

export function noticesOn(storage = globalThis.localStorage) {
  try { return storage.getItem(KEY) !== 'off' } catch { return true }
}
export function setNotices(on, storage = globalThis.localStorage) {
  try { on ? storage.removeItem(KEY) : storage.setItem(KEY, 'off') } catch { /* The choice just lasts for this session. */ }
}

export function createNotifier({ client, signer, storage, where = globalThis.location }) {
  const sent = new Set()
  const link = offerId => {
    try { return `${where.origin}${where.pathname}${offerId ? `#offer/${offerId}` : '#trades'}` } catch { return 'wot-pay' }
  }
  // The recipient's private inbox if they have one; otherwise the app relays
  // that token DMs already use, since public-offer users have no inbox.
  async function deliver(to, wrap) {
    const relays = inboxRelays(await client.queryIdentity({ kinds: [10050], authors: [to] }), to)
    if (relays.length) return client.publishTo(relays, wrap)
    if (!client.sendWrapped) throw new Error('No relay path for notices.')
    return client.sendWrapped([wrap])
  }
  function notify(to, text, { offerId, key } = {}) {
    if (!signer?.wrapNotice || !HEX64.test(to || '') || !noticesOn(storage)) return
    // Only callers that name the exact event are de-duplicated; identical text
    // for different trades must still go out.
    const id = key ? `${to}:${key}` : null
    if (id && sent.has(id)) return
    if (id) sent.add(id)
    void (async () => deliver(to, await signer.wrapNotice(to, `wot-pay: ${text} ${link(offerId)}`)))()
      .catch(() => { if (id) sent.delete(id) })
  }
  // Called after the user's own signed public-offer event was published.
  // offerOf(id) finds the offer so a cancellation can reach its owner.
  function forEvent(event, offerOf) {
    if (!event || event.pubkey !== signer?.pubkey) return
    const to = (pubkey, text) => { if (pubkey && pubkey !== signer.pubkey) notify(pubkey, text, { offerId: event.offerId, key: `${event.type}:${event.id}` }) }
    if (event.type === 'claim') to(event.maker, 'Someone claimed your offer. Open it to review the claim.')
    else if (event.type === 'accept') to(event.counterparty, 'Your claim was accepted. Open the offer to continue.')
    else if (event.type === 'settled') to(event.counterparty, 'Your trade partner marked the trade settled.')
    else if (event.type === 'disputed') to(event.counterparty, 'Your trade partner reported a problem with the trade.')
    else if (event.type === 'cancel') to(offerOf?.(event.offerId)?.pubkey, 'A claim on your offer was cancelled.')
  }
  const tokenSent = (to, offerId) => notify(to, 'Sats were sent for your trade. Open the offer to check and redeem them.', { offerId, key: `token:${offerId}` })
  return { notify, forEvent, tokenSent }
}
