import { parse } from '../events.js'
import { tradeState } from '../trade.js'

// Re-read the public trade immediately before delivering queued pay instructions.
// Missing legacy scope is unsafe. Relay errors throw, leaving the item queued.
export async function mayDeliverMessage(item, { events, query, me }) {
  if (!item.messageScope) return false
  if (!item.requiresAcceptance) return true
  const offer = events.get(item.offerId)
  if (!offer) return false
  const fresh = await query({ '#e': [item.offerId] })
  let sawAcceptance = false
  for (const raw of fresh) {
    const event = parse(raw)
    if (event) { events.set(event.id, event); if (event.type === 'accept' && event.pubkey === offer.pubkey && event.claimId === item.claimId && event.counterparty === me) sawAcceptance = true }
  }
  const state = tradeState(offer, [...events.values()])
  if (!sawAcceptance && state.accepted && state.claim?.id === item.claimId) throw new Error('Maker acceptance not verified by fresh relay read')
  return sawAcceptance && state.accepted && state.claim?.id === item.claimId && state.claim.pubkey === me && state.status === 'claimed'
}
