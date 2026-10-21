# Private marketplace (protocol v3) and release gates

Updated 21 October 2026. This branch implements a client-only protected-trade protocol and UI. It is not approved for production money. Nostr relays, Cashu mints and Blossom storage are external servers; there is no custom application backend.

There is no platform fee and no fee recipient. Optional zaps are offered through the Nostr profile configured in `VITE_SUPPORT_NPUB`, separately from trade funding, ranking and settlement. Mint and network costs still apply and are disclosed in each agreement. Protocol v3 replaced the earlier v2 drafts; v2 agreements were never enabled for real funds and are not accepted.

## How a protected trade works

1. A payer advertises an amount range, price and mint. A requester advertises a QR job. Only amount/rate, mint, availability and identity are public.
2. The requester sends a private quote request. For a payer advertisement it includes the merchant's UPI destination; for a QR job the requester's own proposal carries it.
3. **The payer commits by signing the exact terms.** When the payer built the proposal, the proposal is the payer's signed commitment. When the requester built it, the payer signs an `accept` that references that proposal. Either is valid for five minutes.
4. **The requester commits by funding.** "Accept & fund with Lightning" asks the agreed mint for an invoice; paying it from any Lightning wallet makes the mint sign outputs that are already escrow-locked. Ecash already held at that mint can be pasted instead (advanced). Either way a `funding` notice references the payer's commitment. There is no separate requester accept.
5. The payer's app verifies the escrow at the mint automatically. The payer pays the merchant via UPI and taps "I paid", which reports it and attaches a release to the payer that already carries the payer's signature.
6. The requester taps "Merchant received it", which adds the second signature and settles at the mint. The payer's app verifies the payout automatically. Collection into an external wallet is only needed when exporting.

In the normal case that is three taps for the requester (request, accept & fund, merchant received it) and three for the payer (offer terms, start UPI, I paid). Disputes, splits and cancellations keep their explicit controls.

Every trade message after the proposal names the message it answers (`payload.re`): accept → proposal, funding → payer commitment, payment report and decline → funding. Status follows those signed references, not sender-chosen timestamps.

## Deadlines and late or declined escrow

- Each device records when it first received every message. A message meets a deadline only if both its signed time and its local arrival time are within the deadline plus a 60-second grace, so a backdated message cannot slip in late.
- Funding must arrive within ten minutes of the payer's commitment (plus grace), long enough to pay a Lightning invoice. The invoice panel hides the payment link once the window closes.
- Escrow that arrives late, or that reaches a payer already committed to another trade, is declined with a signed `escrow-declined` message. A payer may also decline any funded escrow before starting payment. Declined escrow never invites a UPI payment, frees the payer's slot, and can only be refunded in full to the requester; both sides see the same signed decline.
- A payer's commitment pauses their advertisements and reserves their slot until on-time funding can no longer arrive. Funded and disputed trades hold the slot.

## Refund timelock

- Every agreement fixes `refundAfter` = quote expiry + 14 days, and escrow is locked with that locktime and the requester's per-trade key as the only refund key.
- After that time the requester can return unresolved escrow to themselves with one signature. The mint enforces the locktime, so a client that lies about the time is rejected, and the refund path can only pay the requester.
- To protect payers, a payer whose reported payment stays unconfirmed for 24 hours is prompted to report a problem, and arbitration is expected to answer within 72 hours, well before the refund date. The UI shows the refund date on every trade.
- This replaces "locked forever": lost keys or an unavailable arbitrator now delay a refund rather than destroy it.

## Lightning funding and trust

- The invoice comes straight from the agreed mint over HTTPS, never from the counterparty or relays. The quote is locked (NUT-20) to the requester's per-trade key, so nobody else can mint it.
- The exact escrow-locked outputs and the quote are saved and replicated to two Blossom hosts before the invoice is shown. If the response is lost: an unpaid or paid-but-unissued quote retries the same saved outputs; an issued quote restores them with NUT-09.
- A trade is funded by one method only; a saved Lightning attempt blocks ecash funding and vice versa, so sats are never locked twice.
- "Where are my sats?" on every funded trade states who can move the escrow and checks its live state at the mint.
- Published pilot limits (`VITE_PILOT_MAX_INR_PER_TRADE`, `VITE_PILOT_MAX_INR_PER_DAY`) are shown in the marketplace and enforced before quoting, proposing, accepting and funding. Protected trading stays disabled until both are set.

## Reputation from completed trades

- After a trade that paid the payer, each party may publish a kind-3408 completion attestation (opt-in). It names the counterparty, an amount range and the week, plus a commitment derived from the private agreement id; never the merchant, UPI ID, exact amount or agreement.
- A completion counts only when both parties attested the same commitment with matching terms. Each party is credited with the trust weight of the other, only when that other party is inside the viewer's graph, and one pair counts at most three times. Refunds and declined trades cannot be attested.

## External signers

- Extensions and remote signers trade through the same NIP-17 messages: the app builds the rumor, the signer NIP-44-encrypts and signs the seal, and a one-time key wraps it. Opening checks that the seal's signer is the message author and that the rumor hashes correctly.
- Private records are sealed with a random per-identity vault key stored only encrypted to the user's own key, unlocked once per session. A key is never created over one that fails to decrypt, and the recovery kit carries it so a browser can reopen records sealed before its key was lost.

## Implemented

- Browse-first Pay a QR, Earn sats and My trades. Until protected trading is configured, scanning a QR posts a public no-escrow offer and the marketplace stays hidden.
- Signed trade messages use dedicated kind 3406 and travel only inside NIP-17 gift wraps addressed to kind-10050 inboxes, so a republished message never renders as a social post. Recovery pointers use kind 3407.
- Fixed and market-linked rates with integer paise/sats arithmetic. Recommended ranking uses the existing relationship/history score with mint and relationship filters.
- Immutable hashed agreements: parties, mint, destination, amount, three escrow keys and mint-cost allowances.
- A 2-of-3 requester/payer/arbitrator Cashu P2PK lock with SIG_ALL bound to the exact outputs, plus a NUT-11 refund timelock: from `refundAfter` (14 days after the quote) the requester's key alone may refund. The 2-of-3 path stays valid after that date. Escrow without exactly this lock and refund key is rejected. Funding is checked with DLEQ and mint proof states. Funding tokens are decoded by the mint's wallet so v4 short keyset ids resolve.
- Release, refund and mutual split proposals with recipient-only payout locks. The official client requires both participants for splits and refuses to sign a different payout after signing once.
- Lost swap responses: every consuming swap goes through one recovery adapter. Unspent inputs allow the identical saved swap to be retried; pending or partly spent inputs keep the operation uncertain; fully spent inputs trigger NUT-09 restoration of the exact saved outputs, rejecting missing, extra, duplicated, substituted or DLEQ-invalid signatures, including under rotated keysets.
- Encrypted IndexedDB records with revision compare-and-set, Web Locks across tabs, and durable outboxes that resend the same wrap.
- AES-256-GCM recovery snapshots replicated to three Blossom hosts with full readback. Two verified copies of the exact operation are required before any mint spend or payout signature.
- Trade operations back up only that trade (its record, keys, proofs and pending messages), so the copy made inside a funding window stays small; full snapshots run in the background. Recovery restores the newest full snapshot and overlays every trade whose own backup is newer, and refuses to continue if the newest copy of any scope is unreadable.
- Three suggested Blossom hosts from different operators are prefilled and can be replaced. Hosts known to share an operator are rejected together (blossom.nostr.build and blossom.band returned identical operator headers). Reads follow CDN redirects because every byte is hash-checked.
- Per-trade arbitrator keys: `npm run arbitrator:keys -- generate` creates an offline seed and the public `escrowKeys` list for the panel. Each trade uses one key chosen from its nonce. When a case arrives, the arbitrator derives only that trade's secret offline (`derive`) and pastes it. A leaked trade key reveals nothing about the seed or other trades.

## Configuration

Copy `.env.example` to `.env`. `VITE_ARBITRATOR_PANEL` contains JSON objects with `name`, a 64-character Nostr public key (`pubkey`) and a 66-character compressed Cashu key (`escrowKey`). Operators must enable their private inboxes. Never put private keys in Vite configuration.

`VITE_PROTECTED_TRADES_ENABLED` defaults to false. Agreement creation requires a valid panel; consuming mint calls additionally require the flag. `VITE_RESTORE_VERIFIED_MINTS` lists mints whose lost-response restoration passed a live test.

A mint qualifies by caching `POST /v1/swap` indefinitely (NUT-19 `ttl: null`) or, with finite or no caching, by advertising NUT-09 and being listed in `VITE_RESTORE_VERIFIED_MINTS`. Run `npm run check:mint -- https://your-mint.example` first; it is read-only.

## Limits and remaining release work

1. **Provider integration:** the automated mint is an in-process cryptographic fixture, not evidence of compatibility with a deployed mint. Validate restoration, fees, key rotation, outages and browser CORS against the chosen mint. A mint remains a custodial dependency.
2. **Refund timelock risk:** a payer who paid but does not dispute before the refund date can lose the escrow to a dishonest requester's solo refund. The dispute prompt and arbitration response time are the mitigation; arbitration availability must be staffed accordingly.
3. **Reputation:** completion attestations prove two keys agreed a trade completed, not that a bank payment happened; colluding parties inside your graph can still vouch for each other within the pair cap. Arbitrator-reviewed outcomes, appeals and penalties are not implemented.
4. **Client coordination:** local locks and observed reservations cannot enforce a global one-trade limit across devices or modified clients.
5. **Arbitrator custody:** the seed must stay on an offline, backed-up device. Losing it loses arbitration for every trade using its keys (the requester timelock still refunds).
6. **Signer security:** device identities keep their secret in localStorage. Extension (NIP-07) and remote (NIP-46) signers with NIP-44 can now trade without the secret entering the app; signers without NIP-44 can browse only. Each money step may prompt the signer several times (messages, backups, Blossom upload authorizations). Complete a security review before live funds.
7. **Recovery:** the known-operator list is small; unknown hosts still need judgement. Suggested hosts' upload and retention policies are only proven when the app uploads and reads back the user's backup. Losing both the kit and device can make recovery impossible.
8. **India/device launch:** real Android/iOS UPI handoff, pending payments, reversals and arbitration workflows need device testing, and operating, tax and legal requirements need qualified review.

## Validation

Run `npm ci`, `npm test` and `npm run build`. Tests exercise real Cashu blind signatures and DLEQ in an in-process mint, and drive two complete marketplace instances (requester and payer) over a simulated relay network: offer → accept-and-fund → UPI → two-signature release → collection, payer decline → refund, and a refused second payer commitment. They do not substitute for the provider and device checks above.
