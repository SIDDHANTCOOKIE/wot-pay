import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyEvent } from 'nostr-tools/pure'
import { npubEncode, nprofileEncode } from 'nostr-tools/nip19'
import { localSigner, extensionSigner, toHexPubkey, npubShort, prefs } from './identity.js'

const pubkey = 'ab'.repeat(32)
let values
beforeEach(() => {
  values = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  })
  vi.stubGlobal('window', {})
})
afterEach(() => vi.unstubAllGlobals())

describe('device identity', () => {
  it('keeps the same signing key when a new app session starts', async () => {
    const first = localSigner()
    const stored = values.get('wot-pay:sk')
    const next = localSigner()
    expect(next.pubkey).toBe(first.pubkey)
    expect(values.get('wot-pay:sk')).toBe(stored)
    const event = await next.sign({ kind: 1, created_at: 1, tags: [], content: 'test' })
    expect(event.pubkey).toBe(first.pubkey)
    expect(verifyEvent(event)).toBe(true)
  })

  it('creates a different identity on an empty device store', () => {
    const first = localSigner().pubkey
    values.clear()
    expect(localSigner().pubkey).not.toBe(first)
  })

  it('uses safe defaults before receiving preferences are saved', () => {
    expect(prefs.trustNpub()).toBe('')
    expect(prefs.lnAddress()).toBe('')
    expect(prefs.mint()).toBe('')
    expect(prefs.receive()).toBe('lightning')
  })

  it('reads saved receiving and trust preferences without changing the key', () => {
    const key = localSigner().pubkey
    prefs.setTrustNpub(npubEncode(pubkey))
    prefs.setLnAddress('test@example.com')
    prefs.setMint('https://mint.example')
    prefs.setReceive('cashu')
    expect(prefs.trustNpub()).toBe(npubEncode(pubkey))
    expect(prefs.lnAddress()).toBe('test@example.com')
    expect(prefs.mint()).toBe('https://mint.example')
    expect(prefs.receive()).toBe('cashu')
    expect(localSigner().pubkey).toBe(key)
  })
})

describe('trust input', () => {
  it('accepts trimmed hex, npub and nprofile forms of the same key', () => {
    expect(toHexPubkey(` ${pubkey.toUpperCase()} `)).toBe(pubkey)
    expect(toHexPubkey(npubEncode(pubkey))).toBe(pubkey)
    expect(toHexPubkey(nprofileEncode({ pubkey, relays: ['wss://relay.example'] }))).toBe(pubkey)
  })

  it('rejects missing, malformed and secret-key inputs', () => {
    for (const value of [undefined, '', 'npub1bad', 'xyz', 'a'.repeat(63), 'nsec1bad']) {
      expect(toHexPubkey(value)).toBeNull()
    }
  })

  it('shortens the displayed npub without exposing a signing key', () => {
    const npub = npubEncode(pubkey)
    expect(npubShort(pubkey)).toBe(`${npub.slice(0, 9)}…${npub.slice(-4)}`)
  })
})

describe('extension signing', () => {
  it('returns null when no extension is present', async () => {
    expect(await extensionSigner()).toBeNull()
  })

  it('delegates signing to the extension rather than a local key', async () => {
    const signEvent = vi.fn().mockResolvedValue({ id: 'signed' })
    window.nostr = { getPublicKey: async () => pubkey, signEvent }
    const signer = await extensionSigner()
    expect(signer.kind).toBe('extension')
    expect(signer.pubkey).toBe(pubkey)
    const template = { kind: 1, tags: [], content: 'test', created_at: 1 }
    expect(await signer.sign(template)).toEqual({ id: 'signed' })
    expect(signEvent).toHaveBeenCalledWith(template)
    expect(values.size).toBe(0)
  })
})
