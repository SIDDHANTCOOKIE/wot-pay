import { afterEach, describe, expect, it, vi } from 'vitest'

async function rate() {
  vi.resetModules()
  return import('./rate.js')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('INR price fallback and cache', () => {
  it('returns null when the price service is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    expect(await (await rate()).inrPerBtc()).toBeNull()
  })

  it('returns null when the response cannot be read as JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => { throw new Error('bad JSON') } }))
    expect(await (await rate()).inrPerBtc()).toBeNull()
  })

  it('does not cache a missing price, so a later attempt can recover', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({}) })
      .mockResolvedValueOnce({ json: async () => ({ bitcoin: { inr: 8_000_000 } }) })
    vi.stubGlobal('fetch', fetch)
    const { inrPerBtc } = await rate()
    expect(await inrPerBtc()).toBeNull()
    expect(await inrPerBtc()).toBe(8_000_000)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('reuses the price within five minutes, then refreshes at the boundary', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const fetch = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ bitcoin: { inr: 8_000_000 } }) })
      .mockResolvedValueOnce({ json: async () => ({ bitcoin: { inr: 9_000_000 } }) })
    vi.stubGlobal('fetch', fetch)
    const { inrPerBtc } = await rate()
    expect(await inrPerBtc()).toBe(8_000_000)
    now += 299_999
    expect(await inrPerBtc()).toBe(8_000_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    now += 1
    expect(await inrPerBtc()).toBe(9_000_000)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not reuse an expired price when refresh fails', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ bitcoin: { inr: 8_000_000 } }) })
      .mockRejectedValueOnce(new Error('offline')))
    const { inrPerBtc } = await rate()
    expect(await inrPerBtc()).toBe(8_000_000)
    now += 300_000
    expect(await inrPerBtc()).toBeNull()
  })
})

describe('suggested sats', () => {
  it('rounds the conversion to whole sats', async () => {
    const { inrToSats } = await rate()
    expect(inrToSats(1, 8_000_000)).toBe(13)
    expect(inrToSats(80, 8_000_000)).toBe(1000)
  })

  it('has no automatic suggestion without a price', async () => {
    const { inrToSats } = await rate()
    expect(inrToSats(80, null)).toBe(0)
  })
})
