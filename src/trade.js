// Fold the events for one offer into its current state.
// events: parsed offer/claim/settled/disputed (see events.parse).

export function tradeState(offer, events, { trustedClaimers } = {}) {
  const related = events.filter((e) => e.offerId === offer.id)
  const eligible = (c) => !trustedClaimers || trustedClaimers.has(c.pubkey) || related.some((s) =>
    isStamp(s) && s.pubkey === offer.pubkey && s.claimId === c.id &&
    s.counterparty === c.pubkey && s.created_at >= c.created_at)
  const claims = related
    .filter(
      (e) =>
        e.type === 'claim' &&
        e.maker === offer.pubkey &&
        e.pubkey !== offer.pubkey &&
        e.created_at >= offer.created_at,
    )
    .filter(eligible)
    // Same-second claims are ordered by id so every device agrees on who leads.
    .filter(
      (c) =>
        !related.some(
          (e) =>
            e.type === 'cancel' &&
            e.claimId === c.id &&
            e.pubkey === c.pubkey &&
            e.created_at >= c.created_at,
        ),
    )
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))

  // The maker picks the claim by stamping it. Until then the first claim leads.
  const makerStamp = latest(
    related.filter(
      (e) =>
        isStamp(e) &&
        e.created_at >= offer.created_at &&
        e.pubkey === offer.pubkey &&
        claims.some((c) => c.id === e.claimId && c.pubkey === e.counterparty && e.created_at >= c.created_at),
    ),
  )
  const claim = (makerStamp?.claimId && claims.find((c) => c.id === makerStamp.claimId)) || claims[0] || null
  const taker = claim?.pubkey
  const takerStamp = taker
    ? latest(
        related.filter(
          (e) =>
            isStamp(e) && e.created_at >= claim.created_at && e.pubkey === taker && e.claimId === claim.id && e.counterparty === offer.pubkey,
        ),
      )
    : undefined

  let status = 'open'
  if (claim) status = 'claimed'
  if (makerStamp || takerStamp) status = 'stamped'
  if (makerStamp?.type === 'settled' && takerStamp?.type === 'settled') status = 'settled'
  if (makerStamp?.type === 'disputed' || takerStamp?.type === 'disputed') status = 'disputed'
  if (status === 'open' && offer.expiresAt && offer.expiresAt < Math.floor(Date.now() / 1000))
    status = 'expired'

  return { status, claims, claim, makerStamp, takerStamp }
}

const isStamp = (e) => e.type === 'settled' || e.type === 'disputed'
const latest = (list) => list.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1))[0]
