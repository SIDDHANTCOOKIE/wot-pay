import { SimplePool } from 'nostr-tools/pool'
import { DEFAULT_RELAYS, KIND, APP_TAG } from './kinds.js'
import { assertNoToken } from './fence.js'
import { GIFT_WRAP } from './dm.js'

export function createRelayClient({ relays = DEFAULT_RELAYS, pool = new SimplePool() } = {}) {
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
    const results = await Promise.allSettled(wraps.flatMap((w) => pool.publish(relays, w)))
    if (!results.some((r) => r.status === 'fulfilled')) throw new Error('no relay accepted the message')
  }

  // Gift wraps are backdated up to two days, so look back a bit further.
  function subscribeWrapped(pubkey, onEvent) {
    const since = Math.floor(Date.now() / 1000) - 3 * 24 * 3600
    const sub = pool.subscribeMany(relays, { kinds: [GIFT_WRAP], '#p': [pubkey], since }, { onevent: onEvent })
    return () => sub.close()
  }

  const close = () => pool.close(relays)

  return { publish, subscribe, query, sendWrapped, subscribeWrapped, close, relays }
}
