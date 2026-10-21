import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { OutputData, getEncodedToken } from '@cashu/cashu-ts'
import { wrapPrivate, openPrivate } from '../marketplace/private.js'
import { encryptBackup, decryptBackup, newRecoverySecret } from '../recovery.js'
import { createEscrowKey } from '../marketplace/escrow.js'
import { testMint } from '../marketplace/test-mint.fixture.js'
import { connectMint } from '../marketplace/escrow.js'
import { useMarketplace } from './useMarketplace.js'

// A minimal hook runtime: enough of React's state, effect, memo and ref
// semantics to drive two real marketplace instances without a DOM.
const runtime = vi.hoisted(() => ({ current: null }))
vi.mock('react', () => ({
  useState: init => runtime.current.state(init),
  useEffect: (fn, deps) => runtime.current.effect(fn, deps),
  useMemo: (fn, deps) => runtime.current.memo(fn, deps),
  useRef: value => runtime.current.ref(value),
}))
vi.mock('../marketplace/backup.js', async () => {
  const { contentHash } = await import('../marketplace/protocol.js')
  const receipt = async operation => ({ operationHash: await contentHash(operation), verifiedCopies: 2, checkedAt: Date.now(), results: [{ server: 'https://a.example', verified: true }, { server: 'https://b.example', verified: true }] })
  return { backupOperation: async (vault, signer, operation) => receipt(operation), syncPrivateBackup: async () => null }
})
vi.mock('../marketplace/escrow.js', async original => ({ ...await original(), connectMint: vi.fn() }))

function mount(hook, ...args) {
  const slots = [], cleanups = []
  const render = () => {
    let i = 0
    const effects = []
    runtime.current = {
      state(init) {
        const k = i++
        if (!(k in slots)) slots[k] = { v: typeof init === 'function' ? init() : init }
        const slot = slots[k]
        return [slot.v, next => { slot.v = typeof next === 'function' ? next(slot.v) : next }]
      },
      effect(fn, deps) {
        const k = i++, previous = slots[k]
        if (previous && deps && deps.every((d, j) => d === previous.deps[j])) return
        previous?.cleanup?.()
        slots[k] = { deps }
        effects.push(() => { const cleanup = fn(); if (typeof cleanup === 'function') { slots[k].cleanup = cleanup; cleanups.push(cleanup) } })
      },
      memo(fn, deps) {
        const k = i++, previous = slots[k]
        if (!previous || deps.some((d, j) => d !== previous.deps[j])) slots[k] = { deps, v: fn() }
        return slots[k].v
      },
      ref(value) { const k = i++; if (!(k in slots)) slots[k] = { current: value }; return slots[k] },
    }
    const api = hook(...args)
    effects.forEach(run => run())
    return api
  }
  render()
  return { api: render, unmount: () => cleanups.forEach(c => c()) }
}

function network() {
  const events = [], listingSubs = [], inboxes = new Map()
  return owner => ({
    relays: ['wss://a.example', 'wss://b.example'],
    query: async filter => events.filter(e => filter.kinds.includes(e.kind)),
    subscribe: (filter, onEvent) => { listingSubs.push(onEvent); return () => {} },
    queryIdentity: async filter => events.filter(e => filter.kinds.includes(e.kind) && (!filter.authors || filter.authors.includes(e.pubkey))),
    subscribePrivate: (urls, pubkey, onEvent) => { inboxes.set(pubkey, [...(inboxes.get(pubkey) || []), onEvent]); return () => {} },
    publish: async e => { events.push(e); if (e.kind === 30078) listingSubs.forEach(f => f(e)); return { ok: 1, total: 1 } },
    publishTo: async (urls, e) => { if (e.kind !== 1059) return events.push(e); for (const f of inboxes.get(e.tags.find(t => t[0] === 'p')[1]) || []) f(e) },
  })
}
function deviceSigner() {
  const sk = generateSecretKey(), secret = newRecoverySecret()
  return { sk, pubkey: getPublicKey(sk), sign: async t => finalizeEvent(t, sk), wrapPrivate: (to, signed) => wrapPrivate(sk, to, signed), openPrivate: w => openPrivate(sk, w),
    sealLocal: async v => new TextDecoder().decode(await encryptBackup(v, secret)), openLocal: async s => decryptBackup(new TextEncoder().encode(s), secret) }
}
async function until(check, what) {
  for (let n = 0; n < 200; n++) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 10)) }
  throw new Error(`Timed out waiting for ${what}`)
}

let mounted = []
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('navigator', { locks: { request: (name, fn) => fn() } })
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
})
afterEach(() => { mounted.forEach(m => m.unmount()); mounted = []; vi.unstubAllGlobals(); vi.unstubAllEnvs() })

async function market() {
  const arbitrator = deviceSigner(), arbitratorEscrow = createEscrowKey()
  vi.stubEnv('VITE_ARBITRATOR_PANEL', JSON.stringify([{ name: 'Test panel', pubkey: arbitrator.pubkey, escrowKey: arbitratorEscrow.pubkey }]))
  vi.stubEnv('VITE_PROTECTED_TRADES_ENABLED', 'true')
  let wallet
  connectMint.mockImplementation(async agreement => (wallet ||= testMint(agreement)))
  const net = network(), requester = deviceSigner(), payer = deviceSigner()
  const r = mount(useMarketplace, net(requester), requester), p = mount(useMarketplace, net(payer), payer)
  mounted.push(r, p)
  await r.api().enableInbox(); await p.api().enableInbox()
  await until(() => r.api().inbox && p.api().inbox, 'inboxes')
  const listing = { v: 3, type: 'payer-listing', listingId: newRecoverySecret(), mint: 'https://mint.example', minPaise: 100, maxPaise: 100000, rateType: 'fixed', rate: '2', available: true, expiresAt: Math.floor(Date.now() / 1000) + 3600 }
  await p.api().publishListing(listing)
  const seen = await until(() => r.api().listings.find(l => l.listingId === listing.listingId), 'listing')
  await r.api().requestQuote(seen, 50000, 1000, { vpa: 'merchant@upi', payee: 'Merchant' })
  const request = await until(() => p.api().records.find(row => row.value.kind === 'request' && row.value.incoming), 'quote request')
  await p.api().propose(request, 1000, 10, 0)
  const trade = who => until(() => who.api().trades[0], 'trade')
  const offered = await trade(r)
  expect(offered.view.offered).toBe(true)
  expect(offered.view.canFund).toBe(true)
  expect(p.api().listings.some(l => l.listingId === listing.listingId)).toBe(false)
  return { r, p, wallet: () => wallet, trade, row: async who => who.api().trades[0], token: async () => {
    const w = await connectMint(offered.value.agreement)
    return getEncodedToken({ mint: 'https://mint.example', unit: 'sat', proofs: w.issue(OutputData.createRandomData(1010, w.getKeyset())) })
  } }
}

it('runs a full protected trade through both hooks: offer → accept-and-fund → UPI → two-signature release → collection', async () => {
  const m = await market()
  await m.r.api().fund(await m.row(m.r), await m.token())
  const notice = await until(async () => (await m.row(m.p)).view.notice, 'funding notice')
  expect(notice.payload.re).toBe((await m.row(m.p)).view.acceptance.id)
  await m.p.api().verifyIncomingFunding(await m.row(m.p))
  expect((await m.row(m.p)).view.canPay).toBe(true)
  await m.p.api().action(await m.row(m.p), 'payment-report', { status: 'successful' })
  await until(async () => (await m.row(m.r)).view.paymentStarted, 'payment report')
  await m.r.api().action(await m.row(m.r), 'merchant-confirmed')
  await m.p.api().proposeResolution(await m.row(m.p), { requesterSats: 0, payerSats: 1000, mintFeeSats: 0, reason: 'Merchant confirmed' })
  await m.p.api().approveResolution(await m.row(m.p), (await m.row(m.p)).value.resolutionOperation)
  const signedOnce = await until(async () => (await m.row(m.r)).view.events.find(e => e.action === 'resolution-approve')?.payload.operation, 'payer signature')
  await m.r.api().approveResolution(await m.row(m.r), signedOnce)
  await m.r.api().settle(await m.row(m.r), (await m.row(m.r)).value.resolutionOperation)
  expect((await m.row(m.r)).view.completed).toBe(true)
  await until(async () => (await m.row(m.p)).view.events.some(e => e.action === 'payout'), 'payout receipt')
  await m.p.api().verifyIncomingPayout(await m.row(m.p))
  expect((await m.row(m.p)).view.completed).toBe(true)
  await expect(m.p.api().collectPayout(await m.row(m.p))).rejects.toThrow('Collection prepared')
  expect(await m.p.api().collectPayout(await m.row(m.p))).toMatch(/^cashu/)
})

it('lets the payer decline funded escrow so both sides converge on a refund signed by both', async () => {
  const m = await market()
  await m.r.api().fund(await m.row(m.r), await m.token())
  await until(async () => (await m.row(m.p)).view.notice, 'funding notice')
  await m.p.api().verifyIncomingFunding(await m.row(m.p))
  await m.p.api().action(await m.row(m.p), 'escrow-declined', { reason: 'Cannot pay today' })
  const declined = await until(async () => { const row = await m.row(m.r); return row.view.declined && row }, 'decline')
  expect([declined.view.status, declined.view.canPay]).toEqual(['late-funding-refund', false])
  await expect(m.p.api().action(await m.row(m.p), 'payment-report', { status: 'started' })).rejects.toThrow()
  await expect(m.r.api().proposeResolution(declined, { requesterSats: 0, payerSats: 1000, mintFeeSats: 0, reason: 'x' })).rejects.toThrow('refunded')
  await m.r.api().proposeResolution(declined, { requesterSats: 1000, payerSats: 0, mintFeeSats: 0, reason: 'Payer declined' })
  await m.r.api().approveResolution(await m.row(m.r), (await m.row(m.r)).value.resolutionOperation)
  const signedOnce = await until(async () => (await m.row(m.p)).view.events.find(e => e.action === 'resolution-approve')?.payload.operation, 'requester signature')
  await m.p.api().approveResolution(await m.row(m.p), signedOnce)
  await m.p.api().settle(await m.row(m.p), (await m.row(m.p)).value.resolutionOperation)
  expect((await m.row(m.p)).view.completed).toBe(true)
})

it('refuses a second payer commitment while the first offer can still be funded', async () => {
  const m = await market()
  const listing = { v: 3, type: 'payer-listing', listingId: newRecoverySecret(), mint: 'https://mint.example', minPaise: 100, maxPaise: 100000, rateType: 'fixed', rate: '2', available: true, expiresAt: Math.floor(Date.now() / 1000) + 3600 }
  await m.p.api().publishListing(listing)
  const seen = await until(() => m.r.api().listings.find(l => l.listingId === listing.listingId), 'second listing')
  await m.r.api().requestQuote(seen, 40000, 800, { vpa: 'merchant@upi' })
  const second = await until(() => m.p.api().records.find(row => row.value.kind === 'request' && row.value.incoming && !row.value.proposal), 'second request')
  await expect(m.p.api().propose(second, 800)).rejects.toThrow('existing accepted trade')
})
