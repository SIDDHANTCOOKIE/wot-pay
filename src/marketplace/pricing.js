export const SERVICE_FEE_BPS = 100
export const TERMS_VERSION = 'wot-pay-v2-2026-10-20'
export const QUOTE_LIFETIME_MS = 5 * 60_000

// Decimal input is converted before arithmetic; binary floats never round money.
export function decimalUnits(input, places = 2) {
  const value = String(input).trim()
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error('Enter a positive decimal amount.')
  const [whole, fraction = ''] = value.split('.')
  if (fraction.length > places) throw new Error(`Use at most ${places} decimal places.`)
  return BigInt(whole) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, '0') || '0')
}

function safe(value) {
  if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount is outside the supported range.')
  return Number(value)
}
const ceil = (n, d) => (n + d - 1n) / d

export function feeBreakdown(payerSats, fundingFeeSats = 0) {
  if (!Number.isSafeInteger(payerSats) || payerSats <= 0 || !Number.isSafeInteger(fundingFeeSats) || fundingFeeSats < 0)
    throw new Error('Sats must be whole, non-negative amounts; the payer quote must be positive.')
  const fee = ceil(BigInt(payerSats), 100n)
  return Object.freeze({ payerSats, serviceFeeSats: Number(fee), fundingFeeSats,
    totalSats: safe(BigInt(payerSats) + fee + BigInt(fundingFeeSats)), feeBps: SERVICE_FEE_BPS })
}

export function quotePrice({ inr, rateType, fixedRate, premium = '0', reference, now = Date.now() }) {
  const paise = decimalUnits(inr)
  safe(paise)
  let payerSats
  if (rateType === 'fixed') {
    const rate = decimalUnits(fixedRate, 6)
    if (rate <= 0n) throw new Error('Rate must be positive.')
    payerSats = safe(ceil(paise * rate, 100_000_000n))
  } else if (rateType === 'market') {
    if (!reference || !Number.isFinite(reference.at) || now < reference.at || now - reference.at >= 300_000)
      throw new Error('Reference unavailable or stale. Refresh or use a fixed rate.')
    const btcPaise = decimalUnits(reference.inr)
    if (btcPaise <= 0n) throw new Error('Invalid market reference.')
    const text = String(premium).trim()
    const bps = decimalUnits(text.startsWith('-') ? text.slice(1) : text) * (text.startsWith('-') ? -1n : 1n)
    if (bps <= -10_000n) throw new Error('The quoted rate must be positive.')
    payerSats = safe(ceil(paise * 100_000_000n * (10_000n + bps), btcPaise * 10_000n))
  } else throw new Error('Choose a pricing method.')
  return Object.freeze({ ...feeBreakdown(payerSats), paise: Number(paise), rateType,
    termsVersion: TERMS_VERSION, createdAt: now, expiresAt: now + QUOTE_LIFETIME_MS })
}
