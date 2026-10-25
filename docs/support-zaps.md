# Optional support and zap invoices

The persistent support card was replaced by a small **Support us** button in the header. The amount form is inside an on-demand modal. Trading has no platform fee and does not depend on a support payment.

The dialog requests a NIP-57 invoice using a disposable sender identity, validates its amount, description-hash commitment, expiry and signature, then displays a QR code with wallet and copy actions. It subscribes for a matching signed kind-9735 receipt from the receiving provider. Invoice creation alone is never labelled paid.

The support owner supplied:

- Nostr recipient: `npub17cth6et9yp0ejv2gwfxzcjucek7msfpqa5pajlv8r4jkzjaxkkvqapeytq`
- Lightning address: `crystalinfinity706645@getalby.com`

These public settings can be overridden with `VITE_SUPPORT_NPUB` and `VITE_SUPPORT_LIGHTNING_ADDRESS`. An explicitly empty support npub hides the control. When replacing the recipient, also configure its own receiving address; the default owner's address is not reused for a different npub.

## Live verification on 25 October 2026

The Alby address endpoint returned HTTP 200 and advertised Nostr support, but reported `minSendable: 1000` and `maxSendable: 0`. It cannot currently accept any positive amount. The app now reports this as receiving being unavailable, without requesting an invoice or opening a wallet.

The owner must enable receiving for this address with the wallet provider or provide another working zap-capable Lightning address. This account setting cannot be fixed by changing the website's UI. No account changes, payments or transfers were performed during verification.

Browser verification confirmed that the card is absent, the header control opens/closes the dialog, amount presets are present, and the live zero-limit wallet response produces the intended readable error. Automated tests use genuinely signed synthetic BOLT-11 invoices and cover successful construction, amount substitution, wrong description commitments, expiry, payee/signature mismatch, receipt matching, forged profiles and unavailable wallets. A successful real invoice/payment test remains blocked on the receiving wallet.

Reference: [NIP-57](https://github.com/nostr-protocol/nips/blob/master/57.md).
