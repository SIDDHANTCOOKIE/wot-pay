import { SimplePool } from 'nostr-tools/pool'
import { DEFAULT_RELAYS, KIND, APP_TAG } from './kinds.js'
import { assertNoToken } from './fence.js'
import { GIFT_WRAP } from './dm.js'

// Ping keeps the connection count honest when a network drops silently.
export function createRelayClient({ relays = DEFAULT_RELAYS, pool = new SimplePool({ enablePing: true, enableReconnect: true }) } = {}) {
  // Every outgoing event passes the token fence, even ones not built by events.js.
  async function publish(signed) {
    assertNoToken(signed)
    const results = await Promise.allSettled(pool.publish(relays, signed))
    const ok = results.filter((r) => r.status === 'fulfilled').length
    if (ok === 0) throw new Error('no relay accepted the event')
    return { ok, total: relays.length }
  }

  // filter: extra NIP-01 filter fields (authors, since, #e ...). Defaults to all four kinds.
  function subscribe(filter, onEvent, { onEose } = {}) {
    const f = { kinds: Object.values(KIND), '#t': [APP_TAG], ...filter }
    const sub = pool.subscribeMany(relays, f, { onevent: onEvent, oneose: onEose })
    return () => sub.close()
  }

  // One-shot fetch, e.g. follow lists for the ranker.
  const query = (filter, { maxWait = 4000 } = {}) => pool.querySync(relays, filter, { maxWait })

  // Token DMs. Only gift wraps go out this way; their content is ciphertext,
  // and the fence still checks them.
  async function sendWrapped(wraps) {
    for (const w of wraps) {
      if (w.kind !== GIFT_WRAP) throw new Error('sendWrapped only sends gift wraps')
      assertNoToken(w)
    }
    // The first wrap is the recipient's copy; the rest are the sender's own.
    // Only the recipient's copy decides success.
    const results = await Promise.all(wraps.map((w) => Promise.allSettled(pool.publish(relays, w))))
    const ok = results[0].filter((r) => r.status === 'fulfilled').length
    if (ok === 0) throw new Error('no relay accepted the message')
    return { ok, total: relays.length }
  }

  // Gift wraps are backdated up to two days, so look back a bit further.
  function subscribeWrapped(pubkey, onEvent) {
    const since = Math.floor(Date.now() / 1000) - 3 * 24 * 3600
    const sub = pool.subscribeMany(relays, { kinds: [GIFT_WRAP], '#p': [pubkey], since }, { onevent: onEvent })
    return () => sub.close()
  }

  // How many relays have a live connection right now.
  const connected = () => [...(pool.listConnectionStatus?.() || new Map()).values()].filter(Boolean).length

  const close = () => pool.close(relays)

  return { publish, subscribe, query, sendWrapped, subscribeWrapped, connected, close, relays }
}
