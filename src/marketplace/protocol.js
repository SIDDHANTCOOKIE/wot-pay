import { verifyEvent } from 'nostr-tools/pure'
import { costBreakdown, TERMS_VERSION } from './pricing.js'
import { digest } from '../recovery.js'
import { pointFromHex } from '@cashu/cashu-ts'

export const MARKET_TAG = 'wot-pay-v3'
export const LISTING_KIND = 30078
// Signed trade messages travel only inside NIP-17 gift wraps. A dedicated kind
// keeps a republished message out of social feeds, where kind 1 would render.
export const TRADE_KIND = 3406
export const QUOTE_LIFETIME = 300
export const FUNDING_WINDOW = 120
// Relay and mint latency allowed past a deadline, on both clocks.
export const GRACE = 60
const HEX = /^[0-9a-f]{64}$/
const KEY = /^(02|03)[0-9a-f]{64}$/
const fail = message => { throw new Error(message) }
const integer = (value, min = 1) => Number.isSafeInteger(value) && value >= min
const exact = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(k => keys.includes(k))
export function httpsOrigin(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('Use an HTTPS mint URL without credentials.')
  return url.toString().replace(/\/$/, '')
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  if (value === undefined || typeof value === 'number' && !Number.isSafeInteger(value)) fail('Non-canonical protocol value.')
  return JSON.stringify(value)
}
export const contentHash = value => digest(new TextEncoder().encode(canonical(value)))

export function validateListing(listing) {
  if (!exact(listing, ['v', 'type', 'listingId', 'mint', 'minPaise', 'maxPaise', 'rateType', 'rate', 'expiresAt', 'available', 'sats', 'paise'])) fail('Unexpected public fields. Payment destinations must stay private.')
  if (listing.v !== 3 || !['payer-listing', 'qr-request'].includes(listing.type) || !HEX.test(listing.listingId) || !integer(listing.expiresAt) || typeof listing.available !== 'boolean') fail('Invalid listing.')
  if (httpsOrigin(listing.mint) !== listing.mint) fail('Use a normalized mint URL.')
  if (listing.type === 'payer-listing') {
    if (!integer(listing.minPaise) || !integer(listing.maxPaise) || listing.minPaise > listing.maxPaise || !['market', 'fixed'].includes(listing.rateType) || typeof listing.rate !== 'string' || listing.rate.length > 24 || !/^-?\d+(\.\d{1,6})?$/.test(listing.rate)) fail('Invalid payer listing price or amount range.')
    if (listing.rateType === 'fixed' ? Number(listing.rate) <= 0 : Number(listing.rate) <= -100) fail('Rate must be positive.')
    if ('paise' in listing || 'sats' in listing) fail('Wrong listing fields.')
  } else if (!integer(listing.paise) || !integer(listing.sats) || ['minPaise', 'maxPaise', 'rateType', 'rate'].some(k => k in listing)) fail('Invalid QR request.')
  return listing
}
export function listingTemplate(listing, now = Math.floor(Date.now() / 1000)) {
  validateListing(listing)
  if (listing.expiresAt <= now) fail('Listing has expired.')
  return { kind: LISTING_KIND, created_at: now, tags: [['t', MARKET_TAG], ['d', `wot-pay:${listing.listingId}`]], content: canonical(listing) }
}
export function parseListing(raw, now = Math.floor(Date.now() / 1000)) {
  try {
    const e = JSON.parse(JSON.stringify(raw))
    if (e.kind !== LISTING_KIND || e.created_at > now + 60 || !verifyEvent(e) || e.content.length > 8000 || e.tags.length !== 2 || e.tags[0]?.join(':') !== `t:${MARKET_TAG}`) return null
    const listing = validateListing(JSON.parse(e.content))
    if (e.tags[1]?.join(':') !== `d:wot-pay:${listing.listingId}`) return null
    return { ...listing, id: e.id, pubkey: e.pubkey, created_at: e.created_at }
  } catch { return null }
}
export function currentListings(events, now = Math.floor(Date.now() / 1000)) {
  const latest = new Map()
  for (const raw of events) {
    const e = parseListing(raw, now)
    if (!e) continue
    const key = `${e.pubkey}:${e.listingId}`, previous = latest.get(key)
    if (!previous || e.created_at > previous.created_at || e.created_at === previous.created_at && e.id < previous.id) latest.set(key, e)
  }
  return [...latest.values()].filter(e => e.available && e.expiresAt > now)
}

export function validateAgreement(a) {
  if (!exact(a, ['v', 'termsVersion', 'nonce', 'listingId', 'requester', 'payer', 'arbitrator', 'escrowKeys', 'mint', 'paise', 'payerSats', 'fundingFeeSats', 'releaseFeeSats', 'escrowSats', 'destination', 'quoteExpiresAt', 'createdAt'])) fail('Unexpected agreement fields.')
  if (a.v !== 3 || a.termsVersion !== TERMS_VERSION || !HEX.test(a.nonce) || !HEX.test(a.listingId) || ![a.requester, a.payer, a.arbitrator].every(k => HEX.test(k)) || new Set([a.requester, a.payer, a.arbitrator]).size !== 3) fail('Agreement requires three distinct identities.')
  if (!exact(a.escrowKeys, ['requester', 'payer', 'arbitrator']) || Object.keys(a.escrowKeys).length !== 3 || !Object.values(a.escrowKeys).every(k => KEY.test(k)) || new Set(Object.values(a.escrowKeys).map(k => k.slice(2))).size !== 3) fail('Agreement requires three distinct escrow keys.')
  try { for (const key of Object.values(a.escrowKeys)) pointFromHex(key) } catch { fail('Agreement contains an invalid curve key.') }
  if (!integer(a.paise) || !integer(a.createdAt, 0) || !integer(a.quoteExpiresAt) || a.quoteExpiresAt !== a.createdAt + QUOTE_LIFETIME || httpsOrigin(a.mint) !== a.mint) fail('Invalid amount, mint or quote deadline.')
  costBreakdown(a.payerSats, a.fundingFeeSats)
  if (!integer(a.releaseFeeSats, 0) || !integer(a.escrowSats) || BigInt(a.escrowSats) !== BigInt(a.payerSats) + BigInt(a.releaseFeeSats)) fail('Invalid escrow fee allowance.')
  if (!exact(a.destination, ['vpa', 'payee', 'note']) || typeof a.destination.vpa !== 'string' || !/^[a-zA-Z0-9.\-_]{1,256}@[a-zA-Z]{2,64}$/.test(a.destination.vpa) || [a.destination.payee, a.destination.note].some(v => v !== undefined && (typeof v !== 'string' || v.length > 256))) fail('Invalid private payment destination.')
  return a
}

const actions = new Set(['quote-request', 'proposal', 'accept', 'funding', 'escrow-declined', 'payout', 'payment-report', 'merchant-confirmed', 'cancel-request', 'cancel-agree', 'dispute', 'evidence', 'resolution', 'resolution-approve', 'follow-up', 'case'])
// payload.re names the message being answered, so trade order follows signed
// references rather than sender-chosen timestamps.
export function privateTemplate(agreementId, action, payload = {}, now = Math.floor(Date.now() / 1000)) {
  if (!HEX.test(agreementId) || !actions.has(action) || payload.re !== undefined && !HEX.test(payload.re)) fail('Invalid private trade message.')
  const content = canonical({ v: 3, agreementId, action, payload })
  if (content.length > 50000) fail('Private message is too large.')
  return { kind: TRADE_KIND, created_at: now, tags: [['t', MARKET_TAG]], content }
}
export function parsePrivate(raw) {
  try {
    const e = JSON.parse(JSON.stringify(raw))
    if (e.kind !== TRADE_KIND || !verifyEvent(e) || e.tags.length !== 1 || e.tags[0]?.join(':') !== `t:${MARKET_TAG}` || e.content.length > 50000 || e.created_at > Math.floor(Date.now() / 1000) + 60) return null
    const body = JSON.parse(e.content)
    if (!exact(body, ['v', 'agreementId', 'action', 'payload']) || body.v !== 3 || !HEX.test(body.agreementId) || !actions.has(body.action) || !body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload) || body.payload.re !== undefined && !HEX.test(body.payload.re)) return null
    return { ...body, id: e.id, pubkey: e.pubkey, created_at: e.created_at }
  } catch { return null }
}

// Funding and redemption evidence are local results of the mint adapter, never
// inferred from a peer's message, screenshot, elapsed deadline or legacy stamp.
// received maps event id -> when this device first saw it. Deadlines hold on
// both the signed time and that arrival time, so backdating cannot beat them.
//
// The payer commits by signing the exact terms: the proposal when the payer
// built it, otherwise an accept that references the proposal. The requester
// commits by funding, with a notice that references the payer's commitment.
export function tradeView(agreement, agreementId, rawEvents, evidence = {}, now = Math.floor(Date.now() / 1000), received = {}) {
  validateAgreement(agreement)
  const { requester, payer, arbitrator } = agreement, participants = [requester, payer]
  const events = rawEvents.map(parsePrivate).filter(e => e && e.agreementId === agreementId && [...participants, arbitrator].includes(e.pubkey))
    .sort((a,b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
  const by = (pk, action, re) => events.filter(e => e.pubkey === pk && e.action === action && e.payload.re === re)
  const onTime = (e, deadline) => e.created_at >= agreement.createdAt && e.created_at <= deadline + GRACE && (received[e.id] ?? e.created_at) <= deadline + GRACE
  const proposal = events.find(e => e.action === 'proposal' && participants.includes(e.pubkey))
  const acceptance = !proposal ? undefined : proposal.pubkey === payer ? proposal : by(payer, 'accept', proposal.id)[0]
  const offered = !!acceptance && onTime(acceptance, agreement.quoteExpiresAt)
  const acceptedAt = offered ? acceptance.created_at : null, fundBy = offered ? acceptedAt + FUNDING_WINDOW : null
  const notice = offered ? by(requester, 'funding', acceptance.id)[0] : undefined
  const lateNotice = !!notice && !onTime(notice, fundBy)
  const declined = !!notice && by(payer, 'escrow-declined', notice.id).length > 0
  const active = events.filter(e => participants.includes(e.pubkey) && offered && e.created_at >= acceptedAt)
  const reports = active.filter(e => e.action === 'payment-report' && e.pubkey === payer && !!notice && e.payload.re === notice.id && ['started', 'pending', 'successful', 'failed'].includes(e.payload.status))
  const cancellation = active.find(e => e.action === 'cancel-request')
  const cancellationAgreed = !!cancellation && active.some(e => e.action === 'cancel-agree' && e.pubkey !== cancellation.pubkey && e.payload.requestId === cancellation.id)
  const dispute = active.find(e => e.action === 'dispute')
  const funded = evidence.funding?.agreementId === agreementId && evidence.funding.verified === true
  // Escrow that arrives late, or that the payer declined, never obligates a
  // UPI payment; it can only be refunded.
  const lateFunding = funded && (declined || lateNotice)
  const completed = funded && evidence.redemption?.agreementId === agreementId && evidence.redemption.verified === true
  const paymentStarted = reports.length > 0
  const merchantConfirmed = active.some(e => e.action === 'merchant-confirmed' && e.pubkey === requester)
  let status = offered ? 'awaiting-funding' : now > agreement.quoteExpiresAt ? 'quote-expired' : 'awaiting-payer'
  if (offered && !notice && !funded && now > fundBy) status = 'funding-expired'
  if (notice && !funded) status = 'escrow-sent'
  if (funded) status = 'funded'
  if (funded && paymentStarted) status = reports.at(-1).payload.status === 'pending' ? 'upi-pending' : 'payment-reported'
  if (funded && merchantConfirmed) status = 'awaiting-release'
  if (lateFunding) status = 'late-funding-refund'
  if (cancellation) status = cancellationAgreed ? 'cancellation-agreed' : 'cancellation-requested'
  if (dispute) status = 'disputed'
  if (completed) status = 'completed'
  const followUps = completed ? active.filter(e => e.action === 'follow-up') : []
  return { status, proposal, acceptance, offered, acceptedAt, fundBy, notice, lateNotice, declined, funded, lateFunding, completed, paymentStarted, merchantConfirmed, cancellation, cancellationAgreed, dispute, followUps, events,
    needsPayerAccept: !!proposal && proposal.pubkey === requester && !acceptance && now <= agreement.quoteExpiresAt,
    canFund: offered && !notice && !funded && !cancellation && !dispute && now <= fundBy,
    canPay: offered && funded && !lateFunding && !completed && !paymentStarted && !cancellation && !dispute,
    occupiesSlot: funded && !lateFunding && !completed,
    mayEscalate: funded && !completed && now >= (evidence.funding.verifiedAt || now) + 600,
  }
}
export const viewOf = (row, now) => tradeView(row.value.agreement, row.id.slice(6), row.value.events, row.value.evidence, now, row.value.received)

export function validateResolution(agreement, view, resolution, author) {
  if (!exact(resolution, ['requesterSats', 'payerSats', 'mintFeeSats', 'reason']) || ![resolution.requesterSats, resolution.payerSats, resolution.mintFeeSats].every(n => integer(n, 0)) || typeof resolution.reason !== 'string' || resolution.reason.length > 1000) fail('Invalid resolution amounts.')
  if (BigInt(resolution.requesterSats) + BigInt(resolution.payerSats) + BigInt(resolution.mintFeeSats) !== BigInt(agreement.escrowSats)) fail('Resolution does not conserve escrow sats.')
  if (![agreement.requester, agreement.payer, agreement.arbitrator].includes(author) || !view.funded || view.completed) fail('Resolution is unavailable.')
  if (author === agreement.arbitrator && !view.dispute) fail('Arbitrator only acts on a dispute.')
  if (view.lateFunding && resolution.payerSats !== 0) fail('Late escrow can only be refunded to the requester.')
  return resolution
}

export function requireFreeSlot(payer, trades, exceptId) {
  if (trades.some(t => t.id !== exceptId && t.agreement.payer === payer && t.view.occupiesSlot)) fail('Payer already has a funded or disputed trade. Resolve it first.')
}

// A payer's other trade (vault rows) holds the slot while funded, or while its
// signed commitment can still be met by on-time funding.
export function payerCommitted(payer, rows, exceptId, now = Math.floor(Date.now() / 1000)) {
  return rows.some(r => {
    if (r.value?.kind !== 'trade' || r.id === exceptId || r.value.agreement.payer !== payer) return false
    const view = viewOf(r, now)
    const reserved = view.offered && !view.funded && !view.declined && !view.cancellationAgreed && (now <= view.fundBy + GRACE || !!view.notice && !view.lateNotice)
    return view.occupiesSlot || reserved
  })
}
