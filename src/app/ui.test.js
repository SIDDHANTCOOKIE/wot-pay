import { afterEach, describe, expect, it, vi } from 'vitest'
import { ago, mintName, rupees, sats } from './ui.jsx'
import { tone, where } from './Orbit.jsx'

afterEach(() => vi.restoreAllMocks())

describe('trust labels match the graph', () => {
  it('distinguishes yourself, direct follows, distant hops and strangers', () => {
    expect(where({ hops: 0 })).toBe('You')
    expect(where({ hops: 1 })).toBe('You follow them')
    expect(where({ hops: 2 })).toBe('2 hops away')
    expect(where({ hops: 3 })).toBe('3 hops away')
    expect(where({ hops: null })).toBe('Outside your web')
  })

  it('keeps strangers neutral rather than implying a trusted connection', () => {
    expect(tone(null)).toBe('far')
    expect(tone({ hops: null, disputes: 0 })).toBe('far')
  })

  it('marks disputes as bad even for a direct follow or your own key', () => {
    for (const hops of [0, 1, 2, null]) {
      expect(tone({ hops, disputes: 1 })).toBe('bad')
    }
  })

  it('uses good for direct connections and a separate tone for distant ones', () => {
    expect(tone({ hops: 0, disputes: 0 })).toBe('good')
    expect(tone({ hops: 1, disputes: 0 })).toBe('good')
    expect(tone({ hops: 2, disputes: 0 })).toBe('ok')
    expect(tone({ hops: 3, disputes: 0 })).toBe('ok')
  })
})

describe('payment display helpers', () => {
  it('keeps the mint host and path while removing the scheme and trailing slash', () => {
    expect(mintName('https://mint.example/Bitcoin/')).toBe('mint.example/Bitcoin')
    expect(mintName('https://mint.example:8443/')).toBe('mint.example:8443')
    expect(mintName('not a URL')).toBe('not a URL')
  })

  it('formats INR and sats with Indian grouping and explicit units', () => {
    expect(rupees(123456.789)).toBe('₹1,23,456.79')
    expect(rupees(0)).toBe('₹0')
    expect(sats(123456)).toBe('1,23,456 sats')
  })

  it('keeps timestamps in the future from showing a negative age', () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000_000)
    expect(ago(10_001)).toBe('just now')
  })

  it('switches age labels at the minute and hour boundaries', () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000_000)
    expect(ago(10_000 - 59)).toBe('just now')
    expect(ago(10_000 - 60)).toBe('1m ago')
    expect(ago(10_000 - 3599)).toBe('59m ago')
    expect(ago(10_000 - 3600)).toBe('1h ago')
  })
})
