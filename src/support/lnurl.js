import { makeZapRequest } from 'nostr-tools/nip57'

// Optional support payments: resolve a Lightning address (LUD-16), ask the
// provider for an invoice for an exact amount (LUD-06), refuse anything that
// does not match what the person chose, and watch for payment (LUD-21 verify
// or a NIP-57 zap receipt). Nothing here touches trade funds, and nothing is
// requested until the person opens the support sheet.
const HEX64 = /^[0-9a-f]{64}$/
const ADDRESS = /^([a-z0-9._+-]{1,64})@((?:[a-z0-9-]+\.)+[a-z]{2,})$/i
const MAX_BODY = 20_000
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
const unhex = text => Uint8Array.from(text.match(/../g) || [], h => parseInt(h, 16))
export const sha256Hex = async data => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data)))
const fail = message => { throw new Error(message) }

// ---- BOLT-11 invoices ------------------------------------------------------
// Only what is needed to check an invoice before showing it: the amount, the
// payment hash, the description hash and when it expires. The signature is not
// verified; the wallet that pays will.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
function polymod(values) {
  let chk = 1
  for (const v of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATORS[i]
  }
  return chk
}
function bech32(text) {
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) fail('Not a valid invoice.')
  const s = text.toLowerCase(), split = s.lastIndexOf('1')
  if (split < 1 || s.length - split < 7) fail('Not a valid invoice.')
  const hrp = s.slice(0, split), data = [...s.slice(split + 1)].map(c => CHARSET.indexOf(c))
  if (data.includes(-1)) fail('Not a valid invoice.')
  const expand = [...hrp].map(c => c.charCodeAt(0) >> 5).concat([0], [...hrp].map(c => c.charCodeAt(0) & 31))
  if (polymod(expand.concat(data)) !== 1) fail('The invoice failed its checksum.')
  return { hrp, words: data.slice(0, -6) }
}
function toBytes(words) {
  let acc = 0, bits = 0
  const out = []
  for (const w of words) {
    acc = (acc << 5) | w; bits += 5
    while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); acc &= (1 << bits) - 1 }
  }
  return Uint8Array.from(out)
}
const MULTIPLIER = { m: 100_000_000n, u: 100_000n, n: 100n }

export function decodeInvoice(invoice) {
  const { hrp, words } = bech32(String(invoice).trim())
  // Mainnet only: a testnet invoice can never be paid by a real wallet.
  const m = /^lnbc(\d*)([munp]?)$/.exec(hrp)
  if (!m) fail('This is not a Bitcoin mainnet Lightning invoice.')
  let msats = null
  if (m[1]) {
    const units = BigInt(m[1])
    if (m[2] === 'p') { if (units % 10n) fail('The invoice amount is not valid.'); msats = units / 10n }
    else msats = units * (MULTIPLIER[m[2]] ?? 100_000_000_000n)
  } else if (m[2]) fail('The invoice amount is not valid.')
  if (words.length < 7 + 104) fail('The invoice is too short.')
  const timestamp = words.slice(0, 7).reduce((n, w) => n * 32 + w, 0)
  const fields = words.slice(7, -104)
  const result = { msats, timestamp, expiry: 3600, paymentHash: null, descriptionHash: null, description: null }
  for (let i = 0; i < fields.length;) {
    const type = fields[i], length = fields[i + 1] * 32 + fields[i + 2], data = fields.slice(i + 3, i + 3 + length)
    if (i + 3 + length > fields.length) fail('The invoice is malformed.')
    if (type === 1 && length === 52) result.paymentHash = hex(toBytes(data).slice(0, 32))
    else if (type === 23 && length === 52) result.descriptionHash = hex(toBytes(data).slice(0, 32))
    else if (type === 13) result.description = new TextDecoder().decode(toBytes(data))
    else if (type === 6) result.expiry = data.reduce((n, w) => n * 32 + w, 0)
    i += 3 + length
  }
  if (!result.paymentHash) fail('The invoice has no payment hash.')
  result.expiresAt = result.timestamp + result.expiry
  return result
}

// ---- LNURL-pay -------------------------------------------------------------
export function parseAddress(address) {
  const m = ADDRESS.exec(String(address || '').trim())
  if (!m) fail('That is not a Lightning address.')
  return { user: m[1].toLowerCase(), domain: m[2].toLowerCase() }
}

async function getJson(url, fetcher, timeout = 10_000) {
  const response = await fetcher(url, { credentials: 'omit', redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) })
  const text = await response.text()
  if (text.length > MAX_BODY) fail('The provider sent an unexpectedly large reply.')
  let body
  try { body = JSON.parse(text) } catch { fail('The provider sent an unreadable reply.') }
  if (body?.status === 'ERROR') fail(String(body.reason || 'The provider refused the request.').replace(/[^\p{L}\p{N} .,'!?:;()%/+-]/gu, '').slice(0, 200))
  if (!response.ok) fail(`The provider answered with an error (${response.status}).`)
  return body
}
const httpsUrl = value => { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u : null } catch { return null } }

export async function resolveAddress(address, fetcher = fetch) {
  const { user, domain } = parseAddress(address)
  const body = await getJson(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(user)}`, fetcher)
  const callback = httpsUrl(body.callback), min = Number(body.minSendable), max = Number(body.maxSendable)
  if (body.tag !== 'payRequest' || !callback || !Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max < min) fail('This address cannot receive payments here.')
  const allowsNostr = body.allowsNostr === true && HEX64.test(body.nostrPubkey || '')
  return { address: `${user}@${domain}`, domain, callback: callback.toString(), minSendable: min, maxSendable: max, minSats: Math.ceil(min / 1000), maxSats: Math.floor(max / 1000), commentAllowed: Number.isSafeInteger(body.commentAllowed) && body.commentAllowed > 0 ? Math.min(body.commentAllowed, 500) : 0, allowsNostr, nostrPubkey: allowsNostr ? body.nostrPubkey : null, metadata: typeof body.metadata === 'string' ? body.metadata : null }
}

// zap: { signer, recipient (hex pubkey), relays } sends a public NIP-57 zap
// request to the provider (never to relays); it is signed by the donor.
export async function requestInvoice(pay, { sats, comment = '', zap = null }, { fetcher = fetch, now = () => Math.floor(Date.now() / 1000) } = {}) {
  if (!Number.isSafeInteger(sats) || sats < 1) fail('Enter a whole number of sats.')
  const msats = BigInt(sats) * 1000n
  if (msats < BigInt(pay.minSendable) || msats > BigInt(pay.maxSendable)) fail(`Choose between ${pay.minSats.toLocaleString('en-US')} and ${pay.maxSats.toLocaleString('en-US')} sats.`)
  const url = new URL(pay.callback)
  url.searchParams.set('amount', msats.toString())
  const text = String(comment).trim()
  if (text && pay.commentAllowed) {
    if (text.length > pay.commentAllowed) fail(`Keep the note under ${pay.commentAllowed} characters.`)
    url.searchParams.set('comment', text)
  }
  let zapJson = null
  if (zap) {
    if (!pay.allowsNostr) fail('This provider does not support Nostr zaps.')
    zapJson = JSON.stringify(await zap.signer.sign(makeZapRequest({ pubkey: zap.recipient, amount: Number(msats), comment: text.slice(0, 500), relays: zap.relays })))
    url.searchParams.set('nostr', zapJson)
  }
  const body = await getJson(url.toString(), fetcher)
  const invoice = decodeInvoice(body.pr)
  // Never show an invoice for a different amount than the one chosen.
  if (invoice.msats !== msats) fail('The provider returned an invoice for a different amount, so it was not shown.')
  if (invoice.expiresAt <= now() + 30) fail('The provider returned an invoice that has already expired.')
  if (zapJson) { if (invoice.descriptionHash !== await sha256Hex(zapJson)) fail('The zap invoice does not match the zap request, so it was not shown.') }
  else if (invoice.descriptionHash && pay.metadata && invoice.descriptionHash !== await sha256Hex(pay.metadata)) fail('The invoice does not match the provider\'s description, so it was not shown.')
  const verify = body.verify === undefined ? null : httpsUrl(body.verify)?.toString() ?? fail('The provider sent an unsafe payment-check link.')
  return { pr: body.pr, sats, msats, paymentHash: invoice.paymentHash, expiresAt: invoice.expiresAt, verify, zapJson }
}

// ---- Knowing it was paid ---------------------------------------------------
// LUD-21: the provider reports settled, ideally with the preimage, which proves
// payment when it hashes to the invoice's payment hash.
export async function checkVerify(invoice, fetcher = fetch) {
  const body = await getJson(invoice.verify, fetcher)
  if (body.settled !== true) return { settled: false }
  if (typeof body.preimage === 'string' && HEX64.test(body.preimage) && await sha256Hex(unhex(body.preimage)) === invoice.paymentHash) return { settled: true, proof: 'preimage' }
  return { settled: true, proof: 'provider' }
}

// A zap receipt (kind 9735) counts only if the provider's own Nostr key signed
// it and it names this exact zap request and invoice.
export function isZapReceipt(event, invoice, pay) {
  try {
    const tag = name => event.tags.find(t => t[0] === name)?.[1]
    return event?.kind === 9735 && event.pubkey === pay.nostrPubkey && tag('bolt11') === invoice.pr && tag('description') === invoice.zapJson
  } catch { return false }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
// Resolves with { settled, proof } or { settled: false, expired: true }. Check
// errors are tolerated; the invoice's own expiry ends the wait. findReceipt is
// an optional async lookup for zap receipts, used when there is no verify link.
export async function waitForPayment(invoice, { fetcher = fetch, findReceipt, interval = 3000, now = () => Math.floor(Date.now() / 1000), signal, sleep = wait } = {}) {
  while (now() < invoice.expiresAt && !signal?.aborted) {
    try {
      if (invoice.verify) { const result = await checkVerify(invoice, fetcher); if (result.settled) return result }
      else if (findReceipt && await findReceipt()) return { settled: true, proof: 'zap-receipt' }
    } catch { /* Try again until the invoice expires. */ }
    await sleep(interval)
  }
  return { settled: false, expired: !signal?.aborted }
}

export const shortHash = hash => `${hash.slice(0, 8)}…${hash.slice(-6)}`
