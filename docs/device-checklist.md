# Phone checklist

Walk this on two real phones (or a phone and a laptop) using the hosted
HTTPS link. Tick each line. Use small amounts: ₹1 to a UPI ID you own is enough.

Phone A is the maker (has the QR). Phone B is the taker (pays it).

## Setup

- [ ] Both phones open the link and show the wot·pay header with a green dot.
- [ ] Profile (tap the npub pill) shows a key on each phone, and the keys differ.
- [ ] On B, paste the npub you use on Damus or Primal, then Save. The nudge
      banner goes away.
- [ ] A follows B (or B follows A) on Nostr, so the trust badge shows "you follow".

## Scan and post (A)

- [ ] The camera asks for permission, then opens with the back camera.
- [ ] Scanning a real shop or GPay QR fills in the payee and UPI ID.
- [ ] A QR with an amount fills the amount. A QR without one lets you type it.
- [ ] A non-UPI QR (a website link) shows "That QR isn't a UPI payment code".
- [ ] Typing a UPI ID by hand works.
- [ ] The sats figure fills in from the live price.
- [ ] Post: the screen moves to "Waiting for someone to pay".

## Claim and pay (B)

- [ ] Board shows A's offer within a few seconds, with the trust badge.
- [ ] Open it. Claim with a Lightning address.
- [ ] "Open UPI app" opens GPay, PhonePe or Paytm with the UPI ID and amount filled in.
- [ ] Pay the ₹1 for real.

## Settle

- [ ] A sees B's claim with the Lightning address, and "Wallet" opens a Lightning wallet.
- [ ] A sends the sats from their wallet, then taps "I sent the sats".
- [ ] B sees "They say the sats are sent", checks the wallet, then taps "Got the sats".
- [ ] Both sides show the done state. B's profile shows 1 settled.

## Ecash (optional)

- [ ] A posts with a Cashu mint URL. The offer shows the mint chip.
- [ ] B claims with Ecash.
- [ ] A pastes a small token from a Cashu wallet (Minibits, eNuts). The amount
      and mint show up, then Send privately.
- [ ] B sees "N sats arrived as ecash". Open wallet redeems it.

## Failure checks

- [ ] Airplane mode on A, then try to post: an error says nothing was sent,
      and the header dot turns red.
- [ ] Airplane mode off: the dot goes green again and posting works.
- [ ] Two phones claim the same offer at once: both show the same person
      as first, and the other sees "You're next in line".
- [ ] Reload mid-trade: A comes back to the same live trade.

## Look and feel

- [ ] Nothing is cut off by the notch or the home bar.
- [ ] Text is readable in sunlight at full brightness.
- [ ] Every button does something real. Note any that don't.
