import { expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { offer } from './events.js'
import { createHistory, verifiedPublicEvent } from './history.js'
import { IDBFactory } from 'fake-indexeddb'

it('revalidates persisted events and refuses mutated events even after signature caching', () => {
  const event = finalizeEvent(offer({ vpa: 'example@upi', inr: 500, sats: 5000 }), generateSecretKey())
  expect(verifiedPublicEvent(event)?.id).toBe(event.id)
  event.content = event.content.replace('5000', '6000')
  expect(verifiedPublicEvent(event)).toBeNull()
})

it('recovers history across instances and retries identical signed operations after reload', async () => {
  const db = new IDBFactory()
  const store = createHistory(db)
  const event = finalizeEvent(offer({ vpa: 'example@upi', inr: 500, sats: 5000 }), generateSecretKey())
  await store.save(event, true)
  const reloaded = createHistory(db)
  expect(await reloaded.load()).toEqual([])
  expect((await reloaded.pending(event.pubkey)).map(e => e.id)).toEqual([event.id])
  expect(await reloaded.pending('another identity')).toEqual([])
  await reloaded.save(event, true)
  expect(await reloaded.pending(event.pubkey)).toHaveLength(1)
  await reloaded.acknowledge(event)
  expect(await store.pending(event.pubkey)).toHaveLength(0)
  expect((await store.load()).map(e => e.id)).toEqual([event.id])
})

it('fails before publishing when durable storage is unavailable', async () => {
  const store = createHistory(null)
  const event = finalizeEvent(offer({ vpa: 'example@upi', inr: 500, sats: 5000 }), generateSecretKey())
  await expect(store.save(event, true)).rejects.toThrow('unavailable')
})
