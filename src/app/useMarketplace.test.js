import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { OutputData, getEncodedToken } from '@cashu/cashu-ts'
import { wrapPrivate, openPrivate } from '../marketplace/private.js'
import { encryptBackup, decryptBackup, newRecoverySecret } from '../recovery.js'
import { childPubkeys } from '../marketplace/arbitrator-keys.js'
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
  // Web Locks stand-in: serializes callbacks per lock name, like the browser.
  const queues = new Map()
  vi.stubGlobal('navigator', { locks: { request: (name, fn) => { const run = (queues.get(name) || Promise.resolve()).then(() => fn()); queues.set(name, run.catch(() => {})); return run } } })
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
})
afterEach(() => { vi.useRealTimers(); mounted.forEach(m => m.unmount()); mounted = []; vi.unstubAllGlobals(); vi.unstubAllEnvs() })

async function market({ requesterSigner = deviceSigner() } = {}) {
  const arbitrator = deviceSigner()
  vi.stubEnv('VITE_ARBITRATOR_PANEL', JSON.stringify([{ name: 'Test panel', pubkey: arbitrator.pubkey, escrowKeys: await childPubkeys(newRecoverySecret(), 4) }]))
  vi.stubEnv('VITE_PROTECTED_TRADES_ENABLED', 'true')
  vi.stubEnv('VITE_PILOT_MAX_INR_PER_TRADE', '1000')
  vi.stubEnv('VITE_PILOT_MAX_INR_PER_DAY', '2000')
  let wallet
  connectMint.mockImplementation(async agreement => (wallet ||= testMint(agreement)))
  const net = network(), requester = requesterSigner, payer = deviceSigner()
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

it('prompts an unconfirmed payer to dispute, then lets the requester alone refund after the timelock', async () => {
  const m = await market()
  await m.r.api().fund(await m.row(m.r), await m.token())
  await until(async () => (await m.row(m.p)).view.notice, 'funding notice')
  await m.p.api().verifyIncomingFunding(await m.row(m.p))
  await m.p.api().action(await m.row(m.p), 'payment-report', { status: 'successful' })
  await until(async () => (await m.row(m.r)).view.paymentStarted, 'payment report')
  await expect(m.r.api().timelockRefund(await m.row(m.r))).rejects.toThrow('timelock has not passed')
  const { refundAfter } = (await m.row(m.r)).value.agreement
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 86400_000 + 5000)
  // The hook's clock ticks each second; the prompt appears on the next tick.
  await until(async () => (await m.row(m.p)).view.disputeDue, 'dispute prompt')
  vi.setSystemTime(refundAfter * 1000)
  await m.r.api().timelockRefund(await m.row(m.r))
  expect((await m.row(m.r)).view.completed).toBe(true)
  await until(async () => (await m.row(m.p)).view.events.some(e => e.action === 'payout'), 'refund receipt')
  await m.p.api().verifyIncomingPayout(await m.row(m.p))
  expect((await m.row(m.p)).view.completed).toBe(true)
})

it('funds by Lightning: the mint issues the invoice and mints straight into escrow, and ecash cannot fund it twice', async () => {
  const m = await market()
  const operation = await m.r.api().prepareLightning(await m.row(m.r))
  expect(operation.invoice).toMatch(/^lnbc/)
  expect((await m.row(m.r)).value.lightningReady).toBe(true)
  expect(await m.r.api().completeLightning(await m.row(m.r))).toBe(false)
  await expect(m.r.api().fund(await m.row(m.r), await m.token())).rejects.toThrow('other method')
  m.wallet().payInvoice(operation.preview.quote.quote)
  expect(await m.r.api().completeLightning(await m.row(m.r))).toBe(true)
  await until(async () => (await m.row(m.p)).view.notice, 'funding notice')
  await m.p.api().verifyIncomingFunding(await m.row(m.p))
  expect((await m.row(m.p)).view.canPay).toBe(true)
  expect(await m.p.api().checkEscrow(await m.row(m.p))).toMatchObject({ state: 'locked', sats: 1000 })
})

it('enforces the published pilot limit before any quote is sent', async () => {
  const m = await market()
  const listing = { v: 3, type: 'payer-listing', listingId: newRecoverySecret(), mint: 'https://mint.example', minPaise: 100, maxPaise: 500000, rateType: 'fixed', rate: '2', available: true, expiresAt: Math.floor(Date.now() / 1000) + 3600 }
  await m.p.api().publishListing(listing)
  const seen = await until(() => m.r.api().listings.find(l => l.listingId === listing.listingId), 'listing')
  await expect(m.r.api().requestQuote(seen, 100001, 2000, { vpa: 'merchant@upi' })).rejects.toThrow('per trade')
})

it('completes a trade in a handful of clicks: escrow and payout are verified automatically', async () => {
  const m = await market() // requester: request quote · payer: offer terms
  const op = await m.r.api().prepareLightning(await m.row(m.r)) // requester: accept & fund
  m.wallet().payInvoice(op.preview.quote.quote) // (paid in the requester's Lightning wallet)
  await m.r.api().completeLightning(await m.row(m.r)) // (the page polls this)
  const verified = await until(async () => { const row = await m.row(m.p); return row.view.canPay && row }, 'automatic escrow verification')
  await m.p.api().action(verified, 'payment-report', { status: 'started' }) // payer: start UPI payment
  await m.p.api().reportPaid(await m.row(m.p)) // payer: I paid
  const release = await until(async () => (await m.row(m.r)).view.payerRelease, 'payer-signed release')
  expect(release.allocation).toMatchObject({ requesterSats: 0, payerSats: 1000 })
  await m.r.api().confirmAndRelease(await m.row(m.r)) // requester: merchant received it
  expect((await m.row(m.r)).view.completed).toBe(true)
  await until(async () => (await m.row(m.p)).view.completed, 'automatic payout verification')
})

it('never releases on the requester\'s click without the payer\'s own signed release', async () => {
  const m = await market()
  await m.r.api().fund(await m.row(m.r), await m.token())
  await until(async () => (await m.row(m.p)).view.canPay, 'automatic escrow verification')
  await expect(m.r.api().confirmAndRelease(await m.row(m.r))).rejects.toThrow('signed release')
  expect((await m.row(m.r)).view.completed).toBe(false)
})

it('lets both parties attest a completed trade, which counts as one mutual completion', async () => {
  const { mutualCompletions } = await import('../marketplace/attestations.js')
  const m = await market()
  await m.r.api().fund(await m.row(m.r), await m.token())
  await until(async () => (await m.row(m.p)).view.canPay, 'automatic escrow verification')
  await m.p.api().action(await m.row(m.p), 'payment-report', { status: 'started' })
  await m.p.api().reportPaid(await m.row(m.p))
  await until(async () => (await m.row(m.r)).view.payerRelease, 'payer-signed release')
  await m.r.api().confirmAndRelease(await m.row(m.r))
  await until(async () => (await m.row(m.p)).view.completed, 'payout verification')
  const a = await m.r.api().attestCompletion(await m.row(m.r)), b = await m.p.api().attestCompletion(await m.row(m.p))
  expect(JSON.stringify([a, b])).not.toContain('merchant@upi')
  expect(mutualCompletions([a, b])).toHaveLength(1)
})

it('trades with an extension-style signer whose secret key never enters the app', async () => {
  const { externalSigner } = await import('../marketplace/external-signer.fixture.js')
  const remote = externalSigner().signer
  expect(remote.sk).toBeUndefined()
  const m = await market({ requesterSigner: remote })
  const op = await m.r.api().prepareLightning(await m.row(m.r))
  m.wallet().payInvoice(op.preview.quote.quote)
  await m.r.api().completeLightning(await m.row(m.r))
  await until(async () => (await m.row(m.p)).view.canPay, 'automatic escrow verification')
  await m.p.api().action(await m.row(m.p), 'payment-report', { status: 'started' })
  await m.p.api().reportPaid(await m.row(m.p))
  await until(async () => (await m.row(m.r)).view.payerRelease, 'payer-signed release')
  await m.r.api().confirmAndRelease(await m.row(m.r))
  expect((await m.row(m.r)).view.completed).toBe(true)
})
