// Fold the events for one offer into its current state.
// events: parsed offer/claim/settled/disputed (see events.parse).

export function tradeState(offer, events) {
  const related = events.filter((e) => e.offerId === offer.id)
  const claims = related
    .filter((e) => e.type === 'claim' && e.maker === offer.pubkey && e.pubkey !== offer.pubkey)
    // Same-second claims are ordered by id so every device agrees on who leads.
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))

  // The maker picks the claim by stamping it. Until then the first claim leads.
  const makerStamp = latest(related.filter((e) => isStamp(e) && e.pubkey === offer.pubkey))
  const claim =
    (makerStamp?.claimId && claims.find((c) => c.id === makerStamp.claimId)) || claims[0] || null
  const taker = claim?.pubkey
  const takerStamp = taker ? latest(related.filter((e) => isStamp(e) && e.pubkey === taker)) : undefined

  let status = 'open'
  if (claim) status = 'claimed'
  if (makerStamp || takerStamp) status = 'stamped'
  if (makerStamp?.type === 'settled' && takerStamp?.type === 'settled') status = 'settled'
  if (makerStamp?.type === 'disputed' || takerStamp?.type === 'disputed') status = 'disputed'
  if (status === 'open' && offer.expiresAt && offer.expiresAt < Math.floor(Date.now() / 1000)) status = 'expired'

  return { status, claims, claim, makerStamp, takerStamp }
}

const isStamp = (e) => e.type === 'settled' || e.type === 'disputed'
const latest = (list) => list.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1))[0]
