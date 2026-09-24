// Failure paths and edge cases across the trade flow.
import { describe, it, expect, vi } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { getEncodedToken } from '@cashu/cashu-ts'
import { offer, parse } from './events.js'
import { tradeState } from './trade.js'
import { parseUpi } from './upi.js'
import { readToken, tokenIssues, wrapToken, openToken } from './dm.js'
import { createRelayClient } from './relays.js'
import { APP_TAG } from './kinds.js'

const M = 'm'.repeat(64), T1 = '1'.repeat(64), T2 = '2'.repeat(64)
const off = (extra = {}) => ({ type: 'offer', id: 'o', pubkey: M, created_at: 1, ...extra })
const cl = (id, pubkey, created_at) => ({ type: 'claim', id, pubkey, offerId: 'o', maker: M, created_at })
const st = (type, pubkey, claimId, created_at, id = `${type}-${created_at}`) => ({ type, id, pubkey, offerId: 'o', claimId, created_at })

describe('racing claims', () => {
  it('two claims in the same second: every device picks the same leader', () => {
    const a = cl('aaa', T1, 5), b = cl('bbb', T2, 5)
    expect(tradeState(off(), [a, b]).claim.id).toBe('aaa')
    expect(tradeState(off(), [b, a]).claim.id).toBe('aaa')
  })

  it('the maker can pick the second claimer by stamping their claim', () => {
    const a = cl('aaa', T1, 5), b = cl('bbb', T2, 6)
    const s = tradeState(off(), [a, b, st('settled', M, 'bbb', 7)])
    expect(s.claim.pubkey).toBe(T2)
  })
})

describe('double stamps', () => {
  const a = cl('aaa', T1, 5)
  it('a later stamp replaces an earlier one from the same side', () => {
    const s = tradeState(off(), [a, st('settled', M, 'aaa', 6), st('disputed', M, 'aaa', 9)])
    expect(s.makerStamp.type).toBe('disputed')
    expect(s.status).toBe('disputed')
  })

  it('same-second double stamps resolve the same way in any order', () => {
    const x = st('settled', M, 'aaa', 6, 'x1'), y = st('disputed', M, 'aaa', 6, 'y1')
    expect(tradeState(off(), [a, x, y]).makerStamp.id).toBe(tradeState(off(), [a, y, x]).makerStamp.id)
  })

  it('a stranger cannot stamp someone else’s trade', () => {
    expect(tradeState(off(), [a, st('disputed', T2, 'aaa', 6)]).status).toBe('claimed')
  })
})

describe('expiry', () => {
  const past = Math.floor(Date.now() / 1000) - 10
  it('an unclaimed offer past its expiry is expired', () => {
    expect(tradeState(off({ expiresAt: past }), []).status).toBe('expired')
  })
  it('a trade already claimed keeps going after expiry', () => {
    const s = tradeState(off({ expiresAt: past }), [cl('aaa', T1, 5)])
    expect(s.status).toBe('claimed')
  })
})

describe('garbage offers from relays', () => {
  const sk = generateSecretKey()
  const raw = (body) =>
    finalizeEvent({ kind: 3401, created_at: 1, tags: [['t', APP_TAG]], content: JSON.stringify({ v: 1, ...body }) }, sk)
  it.each([
    ['NaN amount', { upi: { pa: 'a@ok', am: 'abc' }, sats: 10 }],
    ['negative amount', { upi: { pa: 'a@ok', am: '-5' }, sats: 10 }],
    ['infinite amount', { upi: { pa: 'a@ok', am: '1e400' }, sats: 10 }],
    ['zero sats', { upi: { pa: 'a@ok', am: '10' }, sats: 0 }],
    ['bad vpa', { upi: { pa: 'not a vpa', am: '10' }, sats: 10 }],
  ])('drops %s', (_, body) => {
    expect(parse(raw(body))).toBeNull()
  })
  it('refuses to build an offer over the UPI limit', () => {
    expect(() => offer({ vpa: 'a@ok', inr: 600000, sats: 1 })).toThrow()
  })
})

describe('garbage QR codes', () => {
  it.each([
    '', '   ', 'hello', 'https://example.com', 'upi://mandate?pa=a@ok', 'upi://pay?pn=NoVpa',
    'upi://pay?pa=has space@ok', 'upi://pay?pa=a@ok&cu=USD', 'upi://pay?pa=@ok', 'upi://pay?pa=a@1',
  ])('rejects %j', (qr) => {
    expect(parseUpi(qr)).toBeNull()
  })
  it('rejects non-strings', () => {
    expect(parseUpi(undefined)).toBeNull()
    expect(parseUpi({})).toBeNull()
  })
  it.each(['abc', '-1', '0', '1e400', '9999999'])('ignores a bad amount %j but keeps the payee', (am) => {
    expect(parseUpi(`upi://pay?pa=a@ok&am=${am}`)).toMatchObject({ vpa: 'a@ok', inr: undefined })
  })
  it('handles upper case and encoded @', () => {
    expect(parseUpi('UPI://PAY?pa=shop%40okaxis&am=10')).toMatchObject({ vpa: 'shop@okaxis', inr: 10 })
  })
})

const C = '02' + 'ab'.repeat(32)
const tok = (amount, { mint = 'https://mint.example.com', unit } = {}) =>
  getEncodedToken({ mint, unit, proofs: [{ id: '009a1f293253e41e', amount, secret: 's', C }] })

describe('bad tokens', () => {
  it('rejects corrupted and truncated tokens', () => {
    const t = tok(64)
    expect(readToken(t.slice(0, 30))).toBeNull()
    expect(readToken(t.slice(0, 20) + 'zzzz' + t.slice(24))).toBeNull()
    expect(readToken('cashuB' + 'A'.repeat(40))).toBeNull()
  })
  it('flags short amount, wrong mint and wrong unit', () => {
    const t = readToken(tok(64))
    expect(tokenIssues(t, { sats: 100, mint: 'https://mint.example.com' })).toEqual(['36 sats short'])
    expect(tokenIssues(t, { sats: 64, mint: 'https://other.mint' })).toEqual(['not the mint they asked for'])
    expect(tokenIssues(t, { sats: 64, mint: 'https://mint.example.com/' })).toEqual([])
    const usd = readToken(tok(64, { unit: 'usd' }))
    expect(tokenIssues(usd, { sats: 10 })[0]).toMatch(/usd/)
  })
})

function pool(outcomes) {
  // outcomes: per relay, 'ok' or an error message, used for every publish.
  return {
    publish: vi.fn(() => outcomes.map((o) => (o === 'ok' ? Promise.resolve('') : Promise.reject(new Error(o))))),
    subscribeMany: vi.fn(),
    listConnectionStatus: () => new Map(outcomes.map((o, i) => [`wss://r${i}`, o === 'ok'])),
    close: vi.fn(),
  }
}

describe('degraded relays', () => {
  const sk = generateSecretKey()
  const ev = finalizeEvent(offer({ vpa: 'a@ok', inr: 10, sats: 100 }), sk)
  const relays = ['wss://r0', 'wss://r1', 'wss://r2']

  it('one relay down still publishes, and says how many took it', async () => {
    const c = createRelayClient({ relays, pool: pool(['ok', 'connection failed', 'ok']) })
    await expect(c.publish(ev)).resolves.toEqual({ ok: 2, total: 3 })
    expect(c.connected()).toBe(2)
  })

  it('all relays down fails loudly', async () => {
    const c = createRelayClient({ relays, pool: pool(['connection failed', 'rate-limited', 'connection failed']) })
    await expect(c.publish(ev)).rejects.toThrow('no relay accepted')
    expect(c.connected()).toBe(0)
  })

  it('a DM only counts as sent if the recipient copy lands', async () => {
    const maker = generateSecretKey(), taker = getPublicKey(generateSecretKey())
    const wraps = wrapToken({ sk: maker, to: taker, token: tok(8), offerId: 'a'.repeat(64) })
    let n = 0
    const p = {
      ...pool([]),
      publish: vi.fn(() => (n++ === 0 ? [Promise.reject(new Error('down'))] : [Promise.resolve('')])),
    }
    const c = createRelayClient({ relays: ['wss://r0'], pool: p })
    await expect(c.sendWrapped(wraps)).rejects.toThrow('no relay accepted')
  })
})

describe('DM edge cases', () => {
  const me = generateSecretKey()
  it('ignores junk and non-token DMs', () => {
    expect(openToken({ kind: 1059, content: 'junk', tags: [], pubkey: 'x' }, me)).toBeNull()
    expect(openToken({ kind: 1, content: '' }, me)).toBeNull()
  })
  it('refuses bad recipients and offer ids', () => {
    expect(() => wrapToken({ sk: me, to: 'npub-not-hex', token: tok(8), offerId: 'a'.repeat(64) })).toThrow()
    expect(() => wrapToken({ sk: me, to: 'b'.repeat(64), token: tok(8), offerId: 'short' })).toThrow()
  })
})
