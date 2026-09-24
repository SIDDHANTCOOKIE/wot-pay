import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import * as nip19 from 'nostr-tools/nip19'

const SK = 'wot-pay:sk'
const TRUST = 'wot-pay:trust-npub'
const LN = 'wot-pay:ln-address'
const MINT = 'wot-pay:mint'

// A key kept on this device. Good enough for a demo; use a NIP-07
// extension for anything real.
export function localSigner() {
  let hex = localStorage.getItem(SK)
  if (!hex) {
    hex = bytesToHex(generateSecretKey())
    localStorage.setItem(SK, hex)
  }
  const sk = hexToBytes(hex)
  return {
    kind: 'local',
    pubkey: getPublicKey(sk),
    sign: async (t) => finalizeEvent(t, sk),
  }
}

export async function extensionSigner() {
  if (!window.nostr) return null
  const pubkey = await window.nostr.getPublicKey()
  return { kind: 'extension', pubkey, sign: (t) => window.nostr.signEvent(t) }
}

export function toHexPubkey(input) {
  const s = (input || '').trim()
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase()
  try {
    const d = nip19.decode(s)
    if (d.type === 'npub') return d.data
    if (d.type === 'nprofile') return d.data.pubkey
  } catch {}
  return null
}

export const npubShort = (hex) => {
  const n = nip19.npubEncode(hex)
  return `${n.slice(0, 9)}…${n.slice(-4)}`
}

export const prefs = {
  trustNpub: () => localStorage.getItem(TRUST) || '',
  setTrustNpub: (v) => localStorage.setItem(TRUST, v),
  lnAddress: () => localStorage.getItem(LN) || '',
  setLnAddress: (v) => localStorage.setItem(LN, v),
  mint: () => localStorage.getItem(MINT) || '',
  setMint: (v) => localStorage.setItem(MINT, v),
}
