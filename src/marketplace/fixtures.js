// Ephemeral test identities; never used by the production marketplace.
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { createEscrowKey } from './escrow.js'
import { contentHash, privateTemplate } from './protocol.js'
import { TERMS_VERSION } from './pricing.js'
export async function testTrade() {
  const identities = Object.fromEntries(['requester','payer','arbitrator','outsider'].map(role => { const sk = generateSecretKey(); return [role, { sk, pubkey: getPublicKey(sk) }] }))
  const keys = Object.fromEntries(['requester','payer','arbitrator'].map(role => [role, createEscrowKey()]))
  const now = Math.floor(Date.now() / 1000) - 5
  const agreement = { v: 3, termsVersion: TERMS_VERSION, nonce: '1'.repeat(64), listingId: '2'.repeat(64), requester: identities.requester.pubkey, payer: identities.payer.pubkey, arbitrator: identities.arbitrator.pubkey, escrowKeys: Object.fromEntries(Object.entries(keys).map(([role,k]) => [role,k.pubkey])), mint: 'https://mint.example', paise: 50000, payerSats: 1000, fundingFeeSats: 10, releaseFeeSats: 0, escrowSats: 1000, destination: { vpa: 'example@upi', payee: 'Test merchant' }, createdAt: now, quoteExpiresAt: now + 300, refundAfter: now + 300 + 14 * 86400 }
  const id = await contentHash(agreement)
  const sign = (role, action, payload = {}, at = now + 1) => finalizeEvent(privateTemplate(id, action, payload, at), identities[role].sk)
  return { agreement, id, identities, keys, sign, now }
}
