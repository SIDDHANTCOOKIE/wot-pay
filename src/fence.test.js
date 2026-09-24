import { describe, it, expect, vi } from 'vitest'
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure'
import { findToken, TokenLeakError } from './fence.js'
import { offer, claim } from './events.js'
import { createRelayClient } from './relays.js'

const sk = generateSecretKey()
const ID = 'a'.repeat(64)
const PK = 'c'.repeat(64)

// Real-shaped v3 token (fake proofs) and a v4 prefix.
const V3 = 'cashuA' + Buffer.from(JSON.stringify({
  token: [{ mint: 'https://mint.example.com', proofs: [{ amount: 8, id: '009a1f293253e41e', secret: 's', C: '02ab' }] }],
})).toString('base64url')
const V4 = 'cashuBo2FteBtodHRwczovL21pbnQuZXhhbXBsZS5jb21hdWNzYXQ'
const RAW = JSON.stringify({ mint: 'https://m', proofs: [{ amount: 1, secret: 'x', C: '02' }] })

function fakePool() {
  return { publish: vi.fn(() => [Promise.resolve('ok')]), subscribeMany: vi.fn(), close: vi.fn() }
}

describe('token fence', () => {
  it('detects token-shaped values anywhere in content or tags', () => {
    expect(findToken({ content: V3, tags: [] })).toBe('content')
    expect(findToken({ content: `pay me cashu:${V4}`, tags: [] })).toBe('content')
    expect(findToken({ content: JSON.stringify({ note: RAW }), tags: [] })).toBeTruthy()
    expect(findToken({ content: '{}', tags: [['mint', V3]] })).toBeTruthy()
  })

  it('allows mint URLs and receive methods', () => {
    const ev = offer({ vpa: 'a@upi', inr: 1, sats: 1, mint: 'https://mint.example.com', receive: { method: 'cashu' } })
    expect(findToken(ev)).toBeNull()
  })

  it('builders refuse a token in any field', () => {
    expect(() => offer({ vpa: 'a@upi', inr: 1, sats: 1, note: V3 })).toThrow(TokenLeakError)
    expect(() => claim({ offerId: ID, maker: PK, note: V4 })).toThrow(TokenLeakError)
  })

  it('a token never reaches the relay publisher', async () => {
    const pool = fakePool()
    const relays = createRelayClient({ relays: ['wss://r.example'], pool })
    // Hand-built event bypassing the builders.
    const leaked = finalizeEvent({ kind: 3402, created_at: 1, tags: [['t', 'wot-pay']], content: JSON.stringify({ v: 1, note: V3 }) }, sk)
    await expect(relays.publish(leaked)).rejects.toThrow(TokenLeakError)
    const rawProofs = finalizeEvent({ kind: 3401, created_at: 1, tags: [['t', 'wot-pay']], content: RAW }, sk)
    await expect(relays.publish(rawProofs)).rejects.toThrow(TokenLeakError)
    expect(pool.publish).not.toHaveBeenCalled()

    const clean = finalizeEvent(offer({ vpa: 'a@upi', inr: 1, sats: 1 }), sk)
    await expect(relays.publish(clean)).resolves.toEqual({ ok: 1, total: 1 })
    expect(pool.publish).toHaveBeenCalledTimes(1)
  })
})
