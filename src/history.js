import { verifyEvent } from 'nostr-tools/pure'
import { parse } from './events.js'
import { assertNoToken } from './fence.js'

export function verifiedPublicEvent(raw) {
  try {
    // JSON copy removes nostr-tools' cached verification symbol.
    const event = JSON.parse(JSON.stringify(raw))
    assertNoToken(event)
    return parse(event) && verifyEvent(event) ? event : null
  } catch { return null }
}

export function createHistory(indexedDB = globalThis.indexedDB) {
  let opening
  function database() {
    if (!opening) opening = new Promise((resolve, reject) => {
      if (!indexedDB) { reject(new Error('Local history is unavailable in this browser.')); return }
      const request = indexedDB.open('wot-pay-history', 1)
      request.onupgradeneeded = () => {
        for (const name of ['events', 'outbox']) request.result.createObjectStore(name, { keyPath: 'id' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return opening
  }
  async function run(store, mode, action) {
    const db = await database()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode)
      const request = action(tx.objectStore(store))
      tx.oncomplete = () => resolve(request.result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error || new Error('History save aborted.'))
    })
  }
  async function save(raw, pending = false) {
    const event = verifiedPublicEvent(raw)
    if (!event) throw new Error('Only valid signed public trade events can be saved.')
    await run(pending ? 'outbox' : 'events', 'readwrite', store => store.put(event))
  }
  return {
    save,
    load: async () => (await run('events', 'readonly', s => s.getAll())).map(verifiedPublicEvent).filter(Boolean),
    pending: async (pubkey) => (await run('outbox', 'readonly', s => s.getAll())).map(verifiedPublicEvent).filter(e => e && e.pubkey === pubkey),
    acknowledge: async event => { await save(event); await run('outbox', 'readwrite', s => s.delete(event.id)) },
  }
}
