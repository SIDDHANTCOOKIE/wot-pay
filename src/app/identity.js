import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import * as nip19 from 'nostr-tools/nip19'
import { wrapToken, openToken } from '../dm.js'

const SK = 'wot-pay:sk'
const TRUST = 'wot-pay:trust-npub'
const LN = 'wot-pay:ln-address'
const MINT = 'wot-pay:mint'
const HOW = 'wot-pay:receive'

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
    wrapToken: (to, token, offerId) => wrapToken({ sk, to, token, offerId }),
    openToken: (w) => openToken(w, sk),
  }
}

export async function extensionSigner() {
  if (!window.nostr) return null
  const pubkey = await window.nostr.getPublicKey()
  return {
    kind: 'extension',
    pubkey,
    sign: async (t) => {
      const ev = await window.nostr.signEvent(t)
      if (
        !verifyEvent(ev) ||
        ev.pubkey !== pubkey ||
        ev.kind !== t.kind ||
        ev.created_at !== t.created_at ||
        ev.content !== t.content ||
        JSON.stringify(ev.tags) !== JSON.stringify(t.tags)
      )
        throw new Error('Extension identity changed. Reconnect before posting.')
      return ev
    },
  }
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
  receive: () => localStorage.getItem(HOW) || 'lightning',
  setReceive: (v) => localStorage.setItem(HOW, v),
}

const SIGNER = 'wot-pay:signer'
const BUNKER = 'wot-pay:bunker-session'
const HEX64 = /^[0-9a-f]{64}$/
export function importLocalKey(nsec) {
  const decoded = nip19.decode(String(nsec).trim())
  if (decoded.type !== 'nsec' || decoded.data.length !== 32)
    throw new Error('Enter a valid nsec, not an npub')
  getPublicKey(decoded.data) // rejects invalid scalar before changing storage
  localStorage.setItem(SK, bytesToHex(decoded.data))
  localStorage.setItem(SIGNER, 'local')
  return localSigner()
}
export function exportLocalKey() {
  localSigner()
  return nip19.nsecEncode(hexToBytes(localStorage.getItem(SK)))
}
export function saveSignerChoice(kind) {
  localStorage.setItem(SIGNER, kind)
}
// Signing out retains the device key for recovery, but drops the remote session.
export function signOut() {
  localStorage.setItem(SIGNER, 'signed-out')
  localStorage.removeItem(BUNKER)
}
export function signerChoice() {
  return localStorage.getItem(SIGNER) || 'local'
}
export async function restoreSigner() {
  const kind = signerChoice()
  if (kind === 'signed-out') return null
  if (kind === 'extension') {
    const signer = await extensionSigner()
    if (!signer)
      throw new Error('Your Nostr extension is unavailable. Re-enable it or choose the device key.')
    return signer
  }
  if (kind === 'bunker') {
    const saved = JSON.parse(localStorage.getItem(BUNKER) || 'null')
    if (!saved) throw new Error('Remote signer session missing. Connect again or choose the device key.')
    return bunkerSigner(saved)
  }
  return localSigner()
}
async function bounded(promise, close, ms = 30000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Remote signer timed out. Check your signer app.')), ms)
      }),
    ])
  } catch (e) {
    close()
    throw e
  } finally {
    clearTimeout(timer)
  }
}
async function bunkerSigner(saved) {
  const { BunkerSigner } = await import('nostr-tools/nip46')
  const remote = BunkerSigner.fromBunker(hexToBytes(saved.clientKey), saved.pointer)
  const close = () => {
    void remote.close()
  }
  try {
    await bounded(remote.connect(), close)
    const pubkey = await bounded(remote.getPublicKey(), close)
    if (!HEX64.test(pubkey)) throw new Error('Remote signer returned an invalid public key')
    return {
      kind: 'bunker',
      pubkey,
      close,
      sign: async (template) => {
        const ev = await bounded(remote.signEvent(template), close)
        if (
          !verifyEvent(ev) ||
          ev.pubkey !== pubkey ||
          ev.kind !== template.kind ||
          ev.content !== template.content ||
          ev.created_at !== template.created_at ||
          JSON.stringify(ev.tags) !== JSON.stringify(template.tags)
        )
          throw new Error('Remote signer returned a changed or invalid event')
        return ev
      },
    }
  } catch (e) {
    close()
    throw e
  }
}
export async function connectBunker(input) {
  const url = new URL(String(input).trim())
  if (url.protocol !== 'bunker:' || !HEX64.test(url.hostname))
    throw new Error('Enter a bunker:// connection link from your signer app')
  const relays = url.searchParams.getAll('relay')
  if (
    !relays.length ||
    relays.length > 5 ||
    relays.some((r) => {
      try {
        return new URL(r).protocol !== 'wss:'
      } catch {
        return true
      }
    })
  )
    throw new Error('Bunker needs 1-5 secure wss:// relays')
  const saved = {
    clientKey: bytesToHex(generateSecretKey()),
    pointer: { pubkey: url.hostname, relays, secret: url.searchParams.get('secret') },
  }
  const signer = await bunkerSigner(saved)
  localStorage.setItem(BUNKER, JSON.stringify(saved))
  saveSignerChoice('bunker')
  return signer
}
