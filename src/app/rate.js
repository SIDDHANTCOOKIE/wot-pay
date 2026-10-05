// BTC price in INR. Falls back to null; the user can type sats by hand.
let cached = null

export async function inrPerBtc() {
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=inr')
    const value = (await r.json())?.bitcoin?.inr
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      cached = { value, at: Date.now() }
      return value
    }
  } catch {}
  return null
}

export const inrToSats = (inr, price) => {
  if (!Number.isFinite(inr) || inr <= 0 || !Number.isFinite(price) || price <= 0) return 0
  const sats = Math.round((inr / price) * 1e8)
  return Number.isSafeInteger(sats) && sats > 0 ? sats : 0
}
