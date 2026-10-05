// Fold the events for one offer into its current state.
// events: parsed offer/claim/settled/disputed (see events.parse).

export function tradeState(offer, events) {
  const related = events.filter((e) => e.offerId === offer.id)
  const claims = related
    .filter(
      (e) =>
        e.type === 'claim' &&
        e.maker === offer.pubkey &&
        e.pubkey !== offer.pubkey &&
        e.created_at >= offer.created_at &&
        (!offer.expiresAt || e.created_at < offer.expiresAt),
    )
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

  const acceptance = related.filter(e => e.type === 'accept' && e.pubkey === offer.pubkey &&
    claims.some(c => c.id === e.claimId && c.pubkey === e.counterparty && e.created_at >= c.created_at) &&
    (!offer.expiresAt || e.created_at < offer.expiresAt))
    .sort((a,b) => a.created_at - b.created_at || a.id.localeCompare(b.id))[0]
  // One deterministic signed maker acceptance controls payment access.
  // Legacy maker stamps remain readable, but never unlock new payment instructions.
  const makerStamp = latest(
    related.filter(
      (e) =>
        isStamp(e) &&
        e.created_at >= offer.created_at &&
        e.pubkey === offer.pubkey &&
        (!acceptance || e.claimId === acceptance.claimId) &&
        claims.some((c) => c.id === e.claimId && c.pubkey === e.counterparty && e.created_at >= c.created_at),
    ),
  )
  const claim = (acceptance?.claimId && claims.find(c => c.id === acceptance.claimId)) || (makerStamp?.claimId && claims.find((c) => c.id === makerStamp.claimId)) || claims[0] || null
  const taker = claim?.pubkey
  const takerStamp = taker && (acceptance || makerStamp)
    ? latest(
        related.filter(
          (e) =>
            isStamp(e) && e.created_at >= (acceptance?.created_at || claim.created_at) && e.pubkey === taker && e.claimId === claim.id && e.counterparty === offer.pubkey,
        ),
      )
    : undefined

  let status = 'open'
  if (acceptance || makerStamp) status = 'claimed'
  if (makerStamp || takerStamp) status = 'stamped'
  if (makerStamp?.type === 'settled' && takerStamp?.type === 'settled') status = 'settled'
  if (makerStamp?.type === 'disputed' || takerStamp?.type === 'disputed') status = 'disputed'
  if (status === 'open' && offer.expiresAt && offer.expiresAt < Math.floor(Date.now() / 1000))
    status = 'expired'

  const agreedSats = claim?.sats ?? offer.sats
  return { status, claims, claim, acceptance, accepted: !!acceptance && acceptance.claimId === claim?.id, makerStamp, takerStamp, agreedSats }
}

const isStamp = (e) => e.type === 'settled' || e.type === 'disputed'
const latest = (list) => list.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1))[0]
