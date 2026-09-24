import { describe, it, expect, vi } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { getEncodedToken } from '@cashu/cashu-ts'
import { readToken, wrapToken, openToken, GIFT_WRAP } from './dm.js'
import { findToken, TokenLeakError } from './fence.js'
import { createRelayClient } from './relays.js'

const maker = generateSecretKey()
const taker = generateSecretKey()
const OFFER = 'a'.repeat(64)
const C = '02' + 'ab'.repeat(32)
const TOKEN = getEncodedToken({
  mint: 'https://mint.example.com',
  proofs: [
    { id: '009a1f293253e41e', amount: 8, secret: 's1', C },
    { id: '009a1f293253e41e', amount: 2, secret: 's2', C },
  ],
})

describe('token DMs', () => {
  it('reads amount and mint from a pasted token', () => {
    expect(readToken(`here you go: cashu:${TOKEN}`)).toMatchObject({ token: TOKEN, amount: 10, mint: 'https://mint.example.com' })
    expect(readToken('no token here')).toBeNull()
  })

  it('wraps for both sides, and relays only see ciphertext', () => {
    const wraps = wrapToken({ sk: maker, to: getPublicKey(taker), token: TOKEN, offerId: OFFER })
    expect(wraps).toHaveLength(2)
    for (const w of wraps) {
      expect(w.kind).toBe(GIFT_WRAP)
      expect(JSON.stringify(w)).not.toContain(TOKEN)
      expect(findToken(w)).toBeNull()
    }
    const got = openToken(wraps[0], taker)
    expect(got).toMatchObject({ from: getPublicKey(maker), offerId: OFFER, token: TOKEN, amount: 10 })
    expect(openToken(wraps[1], maker)).toMatchObject({ offerId: OFFER, token: TOKEN })
    expect(openToken(wraps[0], generateSecretKey())).toBeNull()
  })

  it('refuses to wrap something that is not a token', () => {
    expect(() => wrapToken({ sk: maker, to: getPublicKey(taker), token: 'hello', offerId: OFFER })).toThrow()
  })

  it('never sends plaintext: a bare kind 14 with a token is fenced', async () => {
    const pool = { publish: vi.fn(() => [Promise.resolve('ok')]), subscribeMany: vi.fn(), close: vi.fn() }
    const client = createRelayClient({ relays: ['wss://r.example'], pool })
    const plain = finalizeEvent({ kind: 14, created_at: 1, tags: [['p', getPublicKey(taker)]], content: TOKEN }, maker)
    await expect(client.publish(plain)).rejects.toThrow(TokenLeakError)
    await expect(client.sendWrapped([plain])).rejects.toThrow()
    expect(pool.publish).not.toHaveBeenCalled()
    await client.sendWrapped(wrapToken({ sk: maker, to: getPublicKey(taker), token: TOKEN, offerId: OFFER }))
    expect(pool.publish).toHaveBeenCalledTimes(2)
  })
})
