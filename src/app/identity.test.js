import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyEvent, finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { npubEncode, nprofileEncode } from 'nostr-tools/nip19'
import { localSigner, extensionSigner, toHexPubkey, npubShort, prefs } from './identity.js'

const pubkey = 'ab'.repeat(32)
let values
beforeEach(() => {
  values = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
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
    const sk = generateSecretKey(),
      pk = getPublicKey(sk)
    const signEvent = vi.fn(async (t) => finalizeEvent(t, sk))
    window.nostr = { getPublicKey: async () => pk, signEvent }
    const signer = await extensionSigner()
    expect(signer.kind).toBe('extension')
    expect(signer.pubkey).toBe(pk)
    const template = { kind: 1, tags: [], content: 'test', created_at: 1 }
    expect(verifyEvent(await signer.sign(template))).toBe(true)
    expect(signEvent).toHaveBeenCalledWith(template)
    expect(values.size).toBe(0)
  })
})

describe('local login and persisted signer selection', () => {
  it('exports and imports a device key with the same identity', async () => {
    const { exportLocalKey, importLocalKey, restoreSigner } = await import('./identity.js')
    const pk = localSigner().pubkey,
      key = exportLocalKey()
    values.clear()
    expect(importLocalKey(key).pubkey).toBe(pk)
    expect((await restoreSigner()).pubkey).toBe(pk)
  })
  it('refuses npub import without replacing the old key', async () => {
    const { importLocalKey } = await import('./identity.js')
    const pk = localSigner().pubkey
    expect(() => importLocalKey(npubEncode(pubkey))).toThrow()
    expect(localSigner().pubkey).toBe(pk)
  })
  it('restores extension choice and refuses silent fallback when absent', async () => {
    const { restoreSigner, saveSignerChoice } = await import('./identity.js')
    saveSignerChoice('extension')
    await expect(restoreSigner()).rejects.toThrow('unavailable')
    window.nostr = { getPublicKey: async () => pubkey, signEvent: vi.fn() }
    expect((await restoreSigner()).kind).toBe('extension')
    saveSignerChoice('local')
    expect((await restoreSigner()).kind).toBe('local')
  })
  it('rejects unsafe remote signer relay links before connecting', async () => {
    const { connectBunker } = await import('./identity.js')
    await expect(connectBunker(`bunker://${pubkey}?relay=ws://unsafe.example`)).rejects.toThrow('secure')
    await expect(connectBunker('https://not-a-bunker.example')).rejects.toThrow('bunker')
  })
})

describe('extension integrity', () => {
  it('rejects changed events instead of publishing them', async () => {
    const sk = generateSecretKey(),
      pk = getPublicKey(sk)
    window.nostr = {
      getPublicKey: async () => pk,
      signEvent: async (t) => finalizeEvent({ ...t, content: 'changed' }, sk),
    }
    const signer = await extensionSigner()
    await expect(signer.sign({ kind: 1, created_at: 1, tags: [], content: 'intended' })).rejects.toThrow(
      'identity changed',
    )
  })
})


describe('sign out', () => {
  it('stays signed out across restore without replacing the backed-up device identity', async () => {
    const { signOut, restoreSigner, saveSignerChoice } = await import('./identity.js')
    const original = localSigner().pubkey
    const key = values.get('wot-pay:sk')
    signOut()
    expect(await restoreSigner()).toBeNull()
    expect(await restoreSigner()).toBeNull()
    expect(values.get('wot-pay:sk')).toBe(key)
    saveSignerChoice('local')
    expect((await restoreSigner()).pubkey).toBe(original)
  })
  it('removes remote session credentials without calling the extension or creating a key', async () => {
    const { signOut, restoreSigner, saveSignerChoice } = await import('./identity.js')
    window.nostr = { getPublicKey: vi.fn() }
    values.set('wot-pay:bunker-session', 'remote credentials')
    saveSignerChoice('bunker')
    signOut()
    expect(values.has('wot-pay:bunker-session')).toBe(false)
    expect(await restoreSigner()).toBeNull()
    expect(values.has('wot-pay:sk')).toBe(false)
    expect(window.nostr.getPublicKey).not.toHaveBeenCalled()
  })
})
