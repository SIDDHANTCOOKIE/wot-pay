# wot-pay

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

- [x] Nostr event schema (`offer`, `claim`, `settled`, `disputed`), with a
      test that fails if a Cashu token ever reaches a public event
- [x] Web-of-trust ranking (follows, hops, settle count, disputes)
- [x] One end-to-end flow: scan → offer → claim → settle
- [x] Feed / detail / profile screens
- [x] Cashu hand-off: mint hint on offers; tokens move only as NIP-17 DMs
- [x] Optional agent daemon (below)
- [ ] Hosted demo URL

## Setup

Needs Node 22.12 or newer and npm (`node -v` to check; `nvm use` picks it up
from `.nvmrc`). Nothing else: no database,
no server, no API keys.

```
git clone https://github.com/SIDDHANTCOOKIE/wot-upi.git
cd wot-upi
npm ci
npm test
npm run dev
```

Open http://localhost:5173. The app makes a key for you on first load.

**Try a full trade on one laptop:** open the app in a normal window and in a
private window (two different keys). In the first, type a UPI ID such as
`shop@okaxis` under the camera, tap Use, enter an amount and post. In the
second, open Board, tap the offer, enter any Lightning address and claim. Then
tap "I sent the sats" in the first window and "Got the sats" in the second.
No real money moves unless you actually pay.

**On a phone:** browsers only allow the camera on HTTPS, so
`npm run dev` over your Wi-Fi IP opens without a camera (typing a UPI ID
still works). For the camera, use the hosted demo, or deploy the build
anywhere static:

```
npm run build        # outputs dist/
npm run preview      # serves dist/ on port 4173
```

**Check the relays:** `npm run smoke` publishes one event of each kind with a
throwaway key and reads them back. Relays live in `src/kinds.js`.

## Agent (optional)

A small daemon that watches the board for you. It claims offers from people
you follow (1 hop, up to `MAX_INR`), DMs you over NIP-17 to pay the UPI QR,
and stamps the trade when you reply. Sats go to your own Lightning address;
the agent never holds sats and never opens a UPI app.

```
OWNER=npub1... LN_ADDRESS=you@wallet.com MAX_INR=500 npm run agent
```

Talk to it from any NIP-17 client (0xchat, Amethyst): `paid`, `skip`,
`got`, `no`, `status`, `pause`, `resume`. Its key is kept in `.agent-key`.

## Demo video

_Linked here once recorded._

## Known limitations

- We do not verify UTR. A payer can pay UPI and never receive sats; mitigated
  by small amounts, 1-hop-first defaults, and public dispute stamps — not
  eliminated.
- We are a client, not an operator, and not a bank.
- Ecash DMs need the key made on the device. With a browser extension
  signer, claim with Lightning instead.
- If the agent's owner replies `skip` after a claim, the claim stays first in
  line; the maker has to mark it not paid. The agent also forgets an open
  trade if it restarts.
