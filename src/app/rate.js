// BTC price in INR. Falls back to null; the user can type sats by hand.
let cached = null

export async function inrPerBtc() {
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=inr')
    const value = (await r.json())?.bitcoin?.inr
    if (value > 0) {
      cached = { value, at: Date.now() }
      return value
    }
  } catch {}
  return null
}

export const inrToSats = (inr, price) => (price ? Math.round((inr / price) * 1e8) : 0)
