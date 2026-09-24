// Publish one event of each kind with a throwaway key, then read them back.
// Usage: npm run smoke
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { offer, claim, settled, disputed, parse } from './events.js'
import { createRelayClient } from './relays.js'

const maker = generateSecretKey()
const taker = generateSecretKey()
const makerPk = getPublicKey(maker)
const takerPk = getPublicKey(taker)
const relays = createRelayClient()

const o = finalizeEvent(offer({ vpa: 'test@upi', payee: 'smoke test', inr: 1, sats: 1, ttl: 600, mint: 'https://mint.example.com' }), maker)
const c = finalizeEvent(claim({ offerId: o.id, maker: makerPk, receive: { method: 'cashu' } }), taker)
const s = finalizeEvent(settled({ offerId: o.id, claimId: c.id, counterparty: takerPk }), maker)
const d = finalizeEvent(disputed({ offerId: o.id, claimId: c.id, counterparty: makerPk, reason: 'smoke test' }), taker)

for (const ev of [o, c, s, d]) {
  const r = await relays.publish(ev)
  console.log(`published ${parse(ev).type} ${ev.id.slice(0, 8)} to ${r.ok}/${r.total} relays`)
}

const seen = new Set()
await new Promise((resolve) => {
  const stop = relays.subscribe({ authors: [makerPk, takerPk] }, (ev) => {
    const p = parse(ev)
    if (p && !seen.has(ev.id)) {
      seen.add(ev.id)
      console.log(`read back ${p.type} ${ev.id.slice(0, 8)}`)
    }
  }, { onEose: () => { stop(); resolve() } })
  setTimeout(resolve, 8000)
})
relays.close()
console.log(seen.size === 4 ? 'ok: all four kinds round-tripped' : `only ${seen.size}/4 read back`)
process.exit(seen.size === 4 ? 0 : 1)
