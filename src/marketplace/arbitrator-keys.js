import { getPubKeyFromPrivKey } from '@cashu/cashu-ts'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'

// One escrow key per trade, all derived from a seed the arbitrator keeps
// offline. Each child secret is a hash of the seed, so a leaked child key
// reveals nothing about the seed or any other trade's key. (BIP32 xpub
// derivation would not do this: one leaked child plus the public chain code
// exposes the parent.) The deployment publishes only the public keys; a trade
// picks one, and the arbitrator derives that trade's secret when a case needs it.
const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const LABEL = new TextEncoder().encode('wot-pay:arbitrator-escrow:v1:')

export async function childSecret(seedHex, index) {
  const seed = hexToBytes(seedHex)
  if (seed.length !== 32 || !Number.isSafeInteger(index) || index < 0) throw new Error('Use a 32-byte hex seed and a non-negative index.')
  for (let attempt = 0; ; attempt++) {
    const input = new Uint8Array([...seed, ...LABEL, ...[index >>> 24, index >>> 16, index >>> 8, index].map(b => b & 255), attempt])
    const secret = new Uint8Array(await crypto.subtle.digest('SHA-256', input))
    const value = BigInt(`0x${bytesToHex(secret)}`)
    if (value > 0n && value < ORDER) return bytesToHex(secret)
  }
}

export async function childPubkeys(seedHex, count) {
  const keys = []
  for (let i = 0; i < count; i++) keys.push(bytesToHex(getPubKeyFromPrivKey(hexToBytes(await childSecret(seedHex, i)))))
  return keys
}

// Deterministic choice from the agreement nonce, so both sides can check it.
export function pickArbitratorKey(keys, nonce) {
  if (!keys.length) throw new Error('The arbitrator has no published escrow keys.')
  return keys[Number(BigInt(`0x${nonce.slice(0, 12)}`) % BigInt(keys.length))]
}

export async function findChildSecret(seedHex, pubkey, limit = 1024) {
  for (let i = 0; i < limit; i++) {
    const secret = await childSecret(seedHex, i)
    if (bytesToHex(getPubKeyFromPrivKey(hexToBytes(secret))) === pubkey) return { index: i, secret }
  }
  throw new Error('This seed did not produce that escrow key.')
}
