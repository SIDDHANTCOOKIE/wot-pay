# wot-upi

**Track: Freedom Stack (Nostr + Ecash) — BOSS Battle, Bitshala**

## Team

- siddhant

## Problem

UPI moves rupees between people every day, instantly, with no fee — but it is
fully intermediated (NPCI, KYC'd banks) and cannot move sats. Someone with a
UPI QR (a stall, a bill, a person) and someone willing to pay it in sats have
no shared rail. Existing bridges (OpenPleb and similar) solve this by running
an operator: a server, a mint, a dispute process that can see and revoke.

## Approach

A Nostr client, not a bank. Scan a UPI QR, decode `pa` / `pn` / `am`, publish
an `offer` event to public relays. Someone in your web of trust claims it,
pays the VPA directly in GPay/PhonePe, and the maker sends sats — from their
own Lightning or Cashu wallet. Both sides stamp `settled` or `disputed` as
Nostr events. The feed ranks by follows, hop distance, settle count, and
dispute history.

- No backend. Four screens: create, feed, detail, profile.
- Custom event kinds: `offer`, `claim`, `settled`, `disputed`.
- No escrow: this client never holds sats, never verifies UTR, never touches
  the UPI rail. Relays carry tickets; UPI carries rupees; your wallet carries
  sats; the web of trust carries the risk.
- Default visibility is graph-only, not a public firehose of VPAs.

**Trust claim, stated precisely:** no operator can revoke, read, or rewrite
the board. Settlement risk is not removed — it is priced by the graph. The
UPI leg itself stays fully intermediated by NPCI and a KYC'd bank; this
project does not change that.

## What is and is not finished

_Updated as the hack window progresses — see commit history for the honest
version of this._

- [ ] Nostr event schema (`offer`, `claim`, `settled`, `disputed`)
- [ ] Web-of-trust ranking (follows, hops, settle count, disputes)
- [ ] One end-to-end flow: scan → offer → claim → settle
- [ ] Feed / detail / profile screens
- [ ] Optional Cashu receive hint (mint URL + address — never a token — on
      public events; tokens move over NIP-17 DM or out-of-band)

## Setup

_To be filled in as the client is built — will include prerequisites,
install steps, and how to run it on a clean machine._

## Demo video

_Linked here once recorded._

## Known limitations

- We do not verify UTR. A payer can pay UPI and never receive sats; mitigated
  by small amounts, 1-hop-first defaults, and public dispute stamps — not
  eliminated.
- We are a client, not an operator, and not a bank.
