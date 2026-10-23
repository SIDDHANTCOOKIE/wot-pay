// Builds structurally valid mainnet invoices (correct checksum, zero signature)
// and a fake Lightning address provider, for tests. Never used by the app.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
const polymod = values => { let chk = 1; for (const v of values) { const top = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i] } return chk }
const toWords = bytes => { const out = []; let acc = 0, bits = 0; for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); acc &= (1 << bits) - 1 } } if (bits) out.push((acc << (5 - bits)) & 31); return out }
const field = (type, words) => [type, words.length >> 5, words.length & 31, ...words]
const base32 = n => { const w = []; do { w.unshift(n % 32); n = Math.floor(n / 32) } while (n > 0); return w }
const unhex = h => Uint8Array.from(h.match(/../g), x => parseInt(x, 16))
const sha = async b => new Uint8Array(await crypto.subtle.digest('SHA-256', b))
export const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')

export function makeInvoice({ msats, paymentHash, descriptionHash, expiry = 600, timestamp = Math.floor(Date.now() / 1000), description, network = 'bc' }) {
  const stamp = [6, 5, 4, 3, 2, 1, 0].map(i => Math.floor(timestamp / 32 ** i) % 32)
  const data = [...stamp, ...field(1, toWords(unhex(paymentHash)))]
  if (descriptionHash) data.push(...field(23, toWords(unhex(descriptionHash))))
  if (description) data.push(...field(13, toWords(new TextEncoder().encode(description))))
  data.push(...field(6, base32(expiry)), ...new Array(104).fill(0))
  const hrp = `ln${network}${msats ? `${msats / 100n}n` : ''}`
  const expand = [...hrp].map(c => c.charCodeAt(0) >> 5).concat([0], [...hrp].map(c => c.charCodeAt(0) & 31))
  const mod = polymod(expand.concat(data, [0, 0, 0, 0, 0, 0])) ^ 1
  return `${hrp}1${[...data, ...[0, 1, 2, 3, 4, 5].map(i => (mod >> (5 * (5 - i))) & 31)].map(w => CHARSET[w]).join('')}`
}

// A Lightning address provider. options.tamper changes what it returns.
export async function fakeProvider({ domain = 'pay.example', user = 'tips', min = 1000, max = 5_000_000_000, comment = 140, nostr = null, tamper = {}, verifyAfter = 2, preimage = hex(crypto.getRandomValues(new Uint8Array(32))) } = {}) {
  const paymentHash = hex(await sha(unhex(preimage))), calls = { lnurlp: 0, callback: [], verify: 0 }
  const metadata = JSON.stringify([['text/plain', 'Tips for wot-pay']])
  const fetcher = async (input, options = {}) => {
    const url = new URL(input), json = (body, status = 200) => new Response(JSON.stringify(body), { status })
    fetcher.options = options
    if (url.hostname === domain && url.pathname === `/.well-known/lnurlp/${user}`) {
      calls.lnurlp++
      return json({ tag: 'payRequest', callback: tamper.callback ?? `https://${domain}/pay/${user}`, minSendable: min, maxSendable: max, metadata, commentAllowed: comment, ...(nostr ? { allowsNostr: true, nostrPubkey: nostr } : {}), ...tamper.lnurlp })
    }
    if (url.pathname === `/pay/${user}`) {
      calls.callback.push(url.searchParams)
      const msats = BigInt(url.searchParams.get('amount')), zap = url.searchParams.get('nostr')
      const descriptionHash = tamper.descriptionHash ?? hex(await sha(new TextEncoder().encode(zap ?? metadata)))
      return json({ pr: makeInvoice({ msats: tamper.msats ?? msats, paymentHash, descriptionHash, expiry: tamper.expiry ?? 600, timestamp: tamper.timestamp }), verify: tamper.verify ?? `https://${domain}/verify/${paymentHash}`, ...tamper.body })
    }
    if (url.pathname === `/verify/${paymentHash}`) {
      calls.verify++
      if (tamper.verifyError && calls.verify <= tamper.verifyError) return json({ status: 'ERROR', reason: 'try later' }, 500)
      return json({ status: 'OK', settled: calls.verify > verifyAfter, preimage: tamper.preimage ?? (calls.verify > verifyAfter ? preimage : null) })
    }
    return json({ status: 'ERROR', reason: 'not found' }, 404)
  }
  return { fetcher, calls, preimage, paymentHash, metadata, address: `${user}@${domain}` }
}
