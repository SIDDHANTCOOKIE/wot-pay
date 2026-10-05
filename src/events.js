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

function text(value, name, max = 1000) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > max) fail(`${name} must be text up to ${max} characters`)
  return value
}

function checkAmount(value) {
  const amount = Number(value),
    paise = amount * 100
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > MAX_INR ||
    Math.abs(paise - Math.round(paise)) > 1e-7
  )
    fail('inr')
  return Math.round(paise) / 100
}

function checkMint(mint) {
  if (mint === undefined) return undefined
  text(mint, 'mint', 2048)
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
  if (!r || typeof r !== 'object' || Array.isArray(r)) fail('receive')
  if (r.method === 'lightning') {
    if (typeof r.address !== 'string' || r.address.length > 320 || !LN_ADDRESS.test(r.address))
      fail('receive.address must be a lightning address')
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
  if (!Number.isSafeInteger(n) || n <= 0) fail(`${name} must be a positive integer`)
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
  const amount = checkAmount(inr)
  text(payee, 'payee', 256)
  text(note, 'note')
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
  text(note, 'note')
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
  text(note, 'note')
  text(reason, 'reason')
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

export function acceptClaim({ offerId, claimId, counterparty }) {
  return stamp(KIND.ACCEPT, { offerId, claimId: checkId(claimId, 'claimId'), counterparty })
}

export function cancelClaim({ offerId, claimId }) {
  return template(
    KIND.CANCEL,
    [
      ['e', checkId(claimId, 'claimId')],
      ['k', String(KIND.CLAIM)],
      ['e', checkId(offerId, 'offerId'), '', 'root'],
    ],
    {},
  )
}

// Parse a received event into a plain object. Returns null on anything malformed.
export function parse(ev) {
  try {
    if (!ev || !Object.values(KIND).includes(ev.kind)) return null
    if (!HEX64.test(ev.id || '') || !HEX64.test(ev.pubkey || '')) return null
    if (!Number.isSafeInteger(ev.created_at) || ev.created_at < 0 || ev.created_at > Math.floor(Date.now()/1000) + 60) return null
    if (typeof ev.content !== 'string' || ev.content.length > 16000) return null
    if (
      !Array.isArray(ev.tags) ||
      ev.tags.length > 64 ||
      !ev.tags.every(
        (t) => Array.isArray(t) && t.length <= 8 && t.every((v) => typeof v === 'string' && v.length <= 2048),
      )
    )
      return null
    if (!ev.tags.some((t) => t[0] === 't' && t[1] === APP_TAG)) return null
    const body = JSON.parse(ev.content)
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.v !== SCHEMA_VERSION) return null
    const tag = (name, marker) =>
      ev.tags.find((t) => t[0] === name && (marker === undefined || t[3] === marker))?.[1]
    const base = { id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at, kind: ev.kind }
    const note = text(body.note, 'note')
    if (ev.kind === KIND.OFFER) {
      if (!body.upi || typeof body.upi !== 'object' || Array.isArray(body.upi)) return null
      if (typeof body.upi.pa !== 'string' || !VPA.test(body.upi.pa)) return null
      if (!['number', 'string'].includes(typeof body.upi.am)) return null
      const inr = checkAmount(body.upi.am),
        sats = positiveInt(body.sats, 'sats')
      const expTag = tag('expiration'),
        expiresAt = expTag === undefined ? undefined : Number(expTag)
      if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt <= 0)) return null
      return {
        ...base,
        type: 'offer',
        vpa: body.upi.pa,
        payee: text(body.upi.pn, 'payee', 256),
        inr,
        sats,
        mint: checkMint(body.mint),
        receive: checkReceive(body.receive),
        note,
        expiresAt,
      }
    }
    if (ev.kind === KIND.CANCEL)
      return {
        ...base,
        type: 'cancel',
        offerId: checkId(tag('e', 'root'), 'offerId'),
        claimId: checkId(tag('e'), 'claimId'),
      }
    const offerId = checkId(tag('e', 'root') || tag('e'), 'offerId'),
      p = checkId(tag('p'), 'counterparty')
    if (ev.kind === KIND.CLAIM)
      return {
        ...base,
        type: 'claim',
        offerId,
        maker: p,
        mint: checkMint(body.mint),
        receive: checkReceive(body.receive),
        note,
      }
    const claimTag = tag('e', 'reply'),
      claimId = claimTag === undefined ? undefined : checkId(claimTag, 'claimId')
    if (ev.kind === KIND.ACCEPT && !claimId) return null
    const reason = text(body.reason, 'reason')
    if (ev.kind === KIND.DISPUTED && !reason) return null
    return {
      ...base,
      type: ev.kind === KIND.ACCEPT ? 'accept' : ev.kind === KIND.SETTLED ? 'settled' : 'disputed',
      offerId,
      claimId,
      counterparty: p,
      note,
      reason,
    }
  } catch {
    return null
  }
}
