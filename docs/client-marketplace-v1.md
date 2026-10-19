# Client-side marketplace v1: decisions and implementation status

Updated 20 October 2026. This branch is a migration foundation, not a completed protected marketplace. No custom application backend is introduced. Nostr relays, Blossom storage and Cashu mints remain external server dependencies.

## Implemented in this branch

- Browse before signing in; Pay a QR, Earn sats and My trades navigation.
- Example offer explicitly simulated, excluded from network events/counts/reputation, with remembered dismissal and restoration through How it works.
- Camera opens only on an explicit Scan with camera action. Image selection and manual UPI entry are available.
- New QR requests stop at a private browser-only preview. No new payment destination is published by this path. Existing publicly published legacy offers cannot be made private retroactively.
- Fixed sats/INR and market-linked premium/discount previews. Integer paise and BigInt arithmetic; ceil to whole sats. Reference refresh every minute on the preview, stale after five minutes. Explicit fixed-rate fallback; no trust-based price limits.
- Fee calculation: requester pays 1% of the payer quote, rounded up to whole sats, no flat minimum. Funding costs remain explicitly unquoted; the displayed subtotal is not an all-in quote. No collection address or payment API is configured, and no fee is collected.
- Legacy board sorts by combined relationship/history score, highest sats earned per rupee, or newest, with amount/relationship/mint filters. Pending complaints are visible without a misconduct score penalty.
- Accepted legacy claim withdrawals preserve the obligation. Conflicting acceptances block payment instructions. Cashu token metadata is checked against the accepted bid on send and receive.
- Public signed event history and exact-event outbox in IndexedDB. Reloaded data is signature-checked. Older identity-related events and known trade references are queried on relays; omissions remain possible. Retry uses the same signed event ID. Unconfirmed delivery is never described as “nothing sent.”
- Recovery settings: AES-256-GCM encrypted snapshots, random 256-bit recovery secret, downloadable kit, explicit restore preview, optional three-host Blossom replication and readback verification. Missing copies can be repaired by rerunning verification. One unavailable host can still yield two verified copies.

The snapshot includes public history, the identity's pending public events and its local device key if applicable. It does not include legacy token DMs or external signer secrets. The downloaded kit intentionally includes the recovery secret; anyone holding it can decrypt the backup. Encrypted bytes alone go to Blossom. Hostnames are checked for distinctness, but operational independence must be selected by the user. No provider URLs are silently preconfigured.

## Agreed behavior still required before protected trading

1. **Private marketplace protocol:** versioned standing payer advertisements and QR jobs, negotiated bids, private encrypted destination exchange, payer confirmation of the exact destination and quote before funding. Payer advertisements default to market pricing; fixed pricing remains available. Add all-in price sorting when costs are known.
2. **Immutable agreements:** exact parties, amount, mint, arbitrator, three distinct escrow keys, fee terms and quote IDs. Quote lifetime five minutes; funding window two minutes. Late/uncertain funding must be reconciled rather than discarded.
3. **Proven 2-of-3 Cashu escrow:** requester/payer/arbitrator, signatures bound to recipient outputs, validated mint support and funding, release/refund/split/redemption, duplicate-operation recovery and protection against a different output set. Nostr identity signing alone is insufficient. No release of UPI payment instructions before verified funding.
4. **One active funded trade per payer:** disputed trades continue occupying the slot. Client enforcement cannot guarantee a global slot across identities, devices, modified clients or withheld relay events. Detect conflicts and disclose that limitation.
5. **Reports and cases:** UPI successful/pending/failed are participant reports. Cancellation after funding requires agreement or arbitration. Deadlines enable escalation only. Inconclusive disputes remain unresolved; split only with mutual agreement. Post-release complaints become follow-up cases, not clawbacks. Only actual trade participants can open the associated dispute.
6. **Panel operations:** arbitrator availability, case UI, private evidence, reviewed outcomes and delay escalation. An administrator cannot substitute an escrow signing key. Pending complaints are labels; misconduct penalties require authenticated reviewed outcomes, not legacy stamps.
7. **Fee collection:** official-client fee payment bound to the agreement, with idempotent handling and a durable receipt. Modified clients may bypass collection. Platform fees never confer custody over trade principal. Fee collection failure must leave a recovery path for funded escrow.
8. **Manual fee refunds:** failed activation, expiry or cancellation before payer payment starts qualifies for a service-fee refund. After payment starts, the reviewed outcome determines the fee refund. Unresolved cases do not automatically refund. Provide a real fee recipient and support/refund operator before collection is enabled.
9. **Complete active-trade recovery:** backup escrow keys, proofs, output blinding material, agreed terms, signed proposals and in-flight operations; separate personal key material from shared arbitration evidence. Versioned manifests and durable encrypted local copy. At least two verified replicas of the relevant revision before the next money-moving step, third copy retried asynchronously. Automatic repair while the app is open; no promise of repair while closed. Downloadable current manifest and recovery secret must survive loss of the browser.
10. **Integration and device gates:** supported mint selection, arbitrator keys and fee recipient, real provider upload/restore checks, test-mint funding/release/refund/split, lost acknowledgements, concurrent devices, pending UPI, missing arbitrators, Android/iOS camera/image/wallet handoffs and India launch review.

## Security and integration boundaries

The current recovery adapter follows Blossom BUD-01/BUD-02/BUD-11: encrypted bytes are addressed by SHA-256; upload authorization is scoped to the server and blob hash; upload success counts only after matching readback. Redirects are rejected deliberately, so providers requiring redirects need an explicitly reviewed compatibility change. Server retention is not guaranteed by the protocol.

The existing optional agent remains legacy coordination code. It must not be pointed at the future protected protocol without the same agreement, funding, dispute and recovery gates.

No escrow implementation, arbitrator availability, fee receipt, reviewed reputation result or server durability is simulated as real in the UI. Protected trading stays disabled pending the above integration evidence.

## Verification

Run `npm ci`, `npm test` and `npm run build`. On restricted Windows environments, set TEMP and TMP to a writable workspace-local directory if Vitest workers cannot access the default temporary directory. The fake-indexeddb development dependency exercises actual persistence transactions and reload behavior; it is not shipped in the production bundle.

Tests cover exact pricing, arbitrary premiums/discounts, stale references, fee rounding, accepted-trade cancellation, conflicting acceptances, accepted-bid token checks, revalidated persisted signatures, outbox identity preservation, encrypted backup corruption, wrong secrets, unavailable replicas and hash-checked repair. Live mint/Blossom integration and mobile hardware checks remain separate release gates.

References: [Cashu NUT-11](https://cashubtc.github.io/nuts/11/), [Blossom specifications](https://github.com/hzrd149/blossom/tree/master/buds), [OpenPleb](https://github.com/gandlafbtc/open-pleb). OpenPleb's server-held fee remainder is not an enforcement mechanism for this client-only architecture.
