import { SimplePool } from 'nostr-tools/pool'
import { DEFAULT_RELAYS, KIND, APP_TAG } from './kinds.js'
import { assertNoToken } from './fence.js'

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

  const close = () => pool.close(relays)

  return { publish, subscribe, query, close, relays }
}
