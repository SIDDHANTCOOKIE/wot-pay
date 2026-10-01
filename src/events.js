import { KIND, APP_TAG, SCHEMA_VERSION } from './kinds.js'
import { assertNoToken } from './fence.js'

// Event templates (unsigned). Sign with nostr-tools finalizeEvent.
//
// offer    maker has a UPI QR and wants it paid; pays sats in return
// claim    taker says "I'll pay it"
// settled  either side stamps the trade done
// disputed either side stamps the trade failed
//
// Optional on offer and claim:
//   mint     Cashu mint URL (a hint: where sats come from / can go)
//   receive  { method: 'lightning', address } | { method: 'cashu', mint? }
// Never a token. Tokens move over NIP-17 DM.

const VPA = /^[a-zA-Z0-9.\-_]{1,256}@[a-zA-Z]{2,64}$/
const LN_ADDRESS = /^[a-z0-9._\-+]+@[a-z0-9.\-]+\.[a-z]{2,}$/i
const HEX64 = /^[0-9a-f]{64}$/
// Highest UPI limit for a single payment is ₹5 lakh.
export const MAX_INR = 500000

const now = () => Math.floor(Date.now() / 1000)

function fail(msg) {
  throw new Error(`invalid event: ${msg}`)
}

function checkMint(mint) {
  if (mint === undefined) return undefined
  let u
  try {
    u = new URL(mint)
  } catch {
    fail('mint must be a URL')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') fail('mint must be http(s)')
  return u.toString().replace(/\/$/, '')
}

function checkReceive(r) {
  if (r === undefined) return undefined
  if (r.method === 'lightning') {
    if (!LN_ADDRESS.test(r.address || '')) fail('receive.address must be a lightning address')
    return { method: 'lightning', address: r.address }
  }
  if (r.method === 'cashu') {
    const out = { method: 'cashu' }
    if (r.mint !== undefined) out.mint = checkMint(r.mint)
    return out
  }
  fail('receive.method must be lightning or cashu')
}

function checkId(id, name) {
  if (!HEX64.test(id || '')) fail(`${name} must be a 64-char hex id`)
  return id
}

function positiveInt(n, name) {
  if (!Number.isInteger(n) || n <= 0) fail(`${name} must be a positive integer`)
  return n
}

function template(kind, tags, body) {
  const ev = {
    kind,
    created_at: now(),
    tags: [['t', APP_TAG], ...tags],
    content: JSON.stringify({ v: SCHEMA_VERSION, ...body }),
  }
  assertNoToken(ev)
  return ev
}

const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

export function offer({ vpa, payee, inr, sats, mint, receive, note, ttl = 3600 }) {
  if (!VPA.test(vpa || '')) fail('vpa')
  positiveInt(sats, 'sats')
  const amount = Number(inr)
  if (!(amount > 0) || amount > MAX_INR || Math.round(amount * 100) !== amount * 100) fail('inr')
  const m = checkMint(mint)
  const tags = [
    ['inr', amount.toFixed(2)],
    ['sats', String(sats)],
    ['expiration', String(now() + positiveInt(ttl, 'ttl'))],
  ]
  if (m) tags.push(['mint', m])
  return template(
    KIND.OFFER,
    tags,
    strip({
      upi: strip({ pa: vpa, pn: payee || undefined, am: amount.toFixed(2) }),
      sats,
      mint: m,
      receive: checkReceive(receive),
      note: note || undefined,
    }),
  )
}

export function claim({ offerId, maker, mint, receive, note }) {
  return template(
    KIND.CLAIM,
    [
      ['e', checkId(offerId, 'offerId'), '', 'root'],
      ['p', checkId(maker, 'maker')],
    ],
    strip({ mint: checkMint(mint), receive: checkReceive(receive), note: note || undefined }),
  )
}

function stamp(kind, { offerId, claimId, counterparty, note, reason }) {
  const tags = [['e', checkId(offerId, 'offerId'), '', 'root']]
  if (claimId) tags.push(['e', checkId(claimId, 'claimId'), '', 'reply'])
  tags.push(['p', checkId(counterparty, 'counterparty')])
  return template(kind, tags, strip({ note: note || undefined, reason: reason || undefined }))
}

export const settled = (args) => stamp(KIND.SETTLED, { ...args, reason: undefined })

export function disputed(args) {
  if (!args.reason) fail('reason')
  return stamp(KIND.DISPUTED, args)
}

// Parse a received event into a plain object. Returns null on anything malformed.
export function parse(ev) {
  if (!ev || !Object.values(KIND).includes(ev.kind)) return null
  if (!ev.tags?.some((t) => t[0] === 't' && t[1] === APP_TAG)) return null
  let body
  try {
    body = JSON.parse(ev.content)
  } catch {
    return null
  }
  if (!body || body.v !== SCHEMA_VERSION) return null
  const tag = (name, marker) =>
    ev.tags.find((t) => t[0] === name && (marker === undefined || t[3] === marker))?.[1]
  const base = { id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at, kind: ev.kind }

  if (ev.kind === KIND.OFFER) {
    if (!VPA.test(body.upi?.pa || '') || !Number.isInteger(body.sats) || body.sats <= 0) return null
    const inr = Number(body.upi.am)
    if (!Number.isFinite(inr) || inr <= 0 || inr > MAX_INR) return null
    const exp = Number(tag('expiration'))
    return {
      ...base,
      type: 'offer',
      vpa: body.upi.pa,
      payee: body.upi.pn,
      inr,
      sats: body.sats,
      mint: body.mint,
      receive: body.receive,
      note: body.note,
      expiresAt: Number.isFinite(exp) ? exp : undefined,
    }
  }
  const offerId = tag('e', 'root') || tag('e')
  const p = tag('p')
  if (!offerId || !p) return null
  if (ev.kind === KIND.CLAIM) {
    return { ...base, type: 'claim', offerId, maker: p, mint: body.mint, receive: body.receive, note: body.note }
  }
  return {
    ...base,
    type: ev.kind === KIND.SETTLED ? 'settled' : 'disputed',
    offerId,
    claimId: tag('e', 'reply'),
    counterparty: p,
    note: body.note,
    reason: body.reason,
  }
}
