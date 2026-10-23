import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { unwrapEvent } from 'nostr-tools/nip17'
import { offer, claim, cancelClaim, parse } from '../events.js'
import { wrapNotice } from '../marketplace/private.js'
import { createNotifier } from '../notify.js'
import { makeMount } from './hook-harness.fixture.js'

const runtime = vi.hoisted(() => ({ current: null }))
const relay = vi.hoisted(() => ({ client: null }))
vi.mock('react', () => ({
  useState: init => runtime.current.state(init),
  useEffect: (fn, deps) => runtime.current.effect(fn, deps),
  useMemo: (fn, deps) => runtime.current.memo(fn, deps),
  useRef: value => runtime.current.ref(value),
}))
vi.mock('../relays.js', () => ({ createRelayClient: () => relay.client }))
const mount = makeMount(runtime)
const { useBoard } = await import('./useBoard.js')

const person = () => { const sk = generateSecretKey(); return { sk, pubkey: getPublicKey(sk), wrapNotice: (to, text) => wrapNotice(sk, to, text) } }
const where = { origin: 'https://wot-pay.test', pathname: '/' }
// Records what reaches the relays; publish can be made to fail.
function fakeClient() {
  const log = { published: [], wraps: [] }, state = { failPublish: false }
  return {
    log, state, relays: ['wss://a.example'],
    publish: async signed => { if (state.failPublish) throw new Error('no relay accepted the event'); log.published.push(signed); return { ok: 1, total: 1 } },
    sendWrapped: async wraps => { log.wraps.push(...wraps) },
    publishTo: async () => {},
    query: async () => [], queryIdentity: async () => [], queryOn: async () => [],
    subscribe: () => () => {}, subscribePrivate: () => () => {}, subscribeWrapped: () => () => {},
    relayStatus: () => [], connected: () => 1, close() {},
  }
}
const until = async (check, what) => { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)) } throw new Error(`Timed out waiting for ${what}`) }

let mounted = []
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('location', { hash: '', origin: where.origin, pathname: where.pathname })
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('navigator', { onLine: true })
})
afterEach(() => { mounted.forEach(m => m.unmount()); mounted = []; vi.unstubAllGlobals() })

function board(who, onPublished) {
  relay.client = fakeClient()
  const m = mount(useBoard, who.pubkey, who.pubkey, 0, { onPublished })
  mounted.push(m)
  return { m, client: relay.client }
}

it('notifies the offer maker after a claim is published through the board, and nobody when publishing fails', async () => {
  const maker = person(), payer = person()
  const post = parse(finalizeEvent(offer({ vpa: 'merchant@upi', payee: 'Corner Shop', inr: 500, sats: 1234 }), maker.sk))
  const take = finalizeEvent(claim({ offerId: post.id, maker: maker.pubkey, receive: { method: 'lightning', address: 'payer@wallet.example' } }), payer.sk)

  let notifier
  const { m, client } = board(payer, (event, offerOf) => notifier.forEvent(event, offerOf))
  notifier = createNotifier({ client, signer: payer, where })

  client.state.failPublish = true
  await expect(m.api().publish(take)).rejects.toThrow('Delivery unconfirmed')
  await new Promise(r => setTimeout(r, 30))
  expect(client.log.wraps.length).toBe(0)

  client.state.failPublish = false
  await m.api().publish(take)
  await until(() => client.log.wraps.length === 1, 'claim notice')
  expect(client.log.published.map(e => e.id)).toEqual([take.id])
  const notice = unwrapEvent(client.log.wraps[0], maker.sk)
  expect(notice.pubkey).toBe(payer.pubkey)
  expect(notice.content).toBe(`wot-pay: Someone claimed your offer. Open it to review the claim. https://wot-pay.test/#offer/${post.id}`)
  expect(notice.content).not.toMatch(/merchant@upi|Corner Shop|1234|payer@wallet/)
})

it('tells the offer owner when a claim is cancelled, using the offer the board already holds', async () => {
  const maker = person(), payer = person()
  const post = finalizeEvent(offer({ vpa: 'merchant@upi', inr: 500, sats: 1234 }), maker.sk)
  const take = finalizeEvent(claim({ offerId: post.id, maker: maker.pubkey, receive: { method: 'lightning', address: 'payer@wallet.example' } }), payer.sk)
  let notifier
  const { m, client } = board(payer, (event, offerOf) => notifier.forEvent(event, offerOf))
  notifier = createNotifier({ client, signer: payer, where })
  m.unmount()
  // The board learns the offer from its live subscription, as it does in the app.
  relay.client = client
  client.subscribe = (filter, onEvent) => { onEvent(post); return () => {} }
  const live = mount(useBoard, payer.pubkey, payer.pubkey, 0, { onPublished: (event, offerOf) => notifier.forEvent(event, offerOf) })
  mounted.push(live)
  await live.api().publish(take)
  await until(() => client.log.wraps.length === 1, 'claim notice')
  await live.api().publish(finalizeEvent(cancelClaim({ offerId: post.id, claimId: take.id }), payer.sk))
  await until(() => client.log.wraps.length === 2, 'cancellation notice')
  const texts = client.log.wraps.map(w => unwrapEvent(w, maker.sk).content)
  expect(texts[1]).toBe(`wot-pay: A claim on your offer was cancelled. https://wot-pay.test/#offer/${post.id}`)
})

it('never turns a published event into an error because a notice failed', async () => {
  const payer = person(), maker = person()
  const take = finalizeEvent(claim({ offerId: 'a'.repeat(64), maker: maker.pubkey, receive: { method: 'lightning', address: 'payer@wallet.example' } }), payer.sk)
  const { m, client } = board(payer, () => { throw new Error('notice code exploded') })
  const result = await m.api().publish(take)
  expect(result).toMatchObject({ ok: 1 })
  expect(client.log.published).toHaveLength(1)
})

it('tells the recipient when sats are sent as a token DM, once per offer', async () => {
  const { useTokens } = await import('./useTokens.js')
  const { wrapToken, openToken } = await import('../dm.js')
  const { getEncodedToken } = await import('@cashu/cashu-ts')
  const maker = person(), payer = person(), offerId = 'b'.repeat(64)
  const token = getEncodedToken({ mint: 'https://mint.example', unit: 'sat', proofs: [{ id: '00' + '1'.repeat(14), amount: 8, secret: '2'.repeat(64), C: '02' + '3'.repeat(64) }] })
  const client = fakeClient()
  const signer = { ...payer, wrapToken: (to, text, id) => wrapToken({ sk: payer.sk, to, token: text, offerId: id }), openToken: w => openToken(w, payer.sk) }
  const notifier = createNotifier({ client, signer, where })
  const tokens = mount(useTokens, client, signer, notifier)
  mounted.push(tokens)
  await tokens.api().send(maker.pubkey, token, offerId)
  await tokens.api().send(maker.pubkey, token, offerId)
  // Two gift wraps per send (recipient and the sender's copy), plus one notice in total.
  await until(() => client.log.wraps.length === 5, 'token wraps and one notice')
  const notices = client.log.wraps.map(w => { try { return unwrapEvent(w, maker.sk) } catch { return null } }).filter(r => r && !r.tags.some(t => t[0] === 'subject'))
  expect(notices).toHaveLength(1)
  expect(notices[0].content).toBe(`wot-pay: Sats were sent for your trade. Open the offer to check and redeem them. https://wot-pay.test/#offer/${offerId}`)
  expect(notices[0].content).not.toContain('cashu')
})
