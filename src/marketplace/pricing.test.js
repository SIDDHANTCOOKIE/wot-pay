import { describe, expect, it } from 'vitest'
import { decimalUnits, feeBreakdown, quotePrice, LEGACY_TERMS_VERSION } from './pricing.js'

describe('locked marketplace prices', () => {
  it('charges no platform fee for new trades and preserves old signed terms', () => {
    expect(feeBreakdown(10000,7)).toMatchObject({serviceFeeSats:0,totalSats:10007,feeBps:0})
    expect(feeBreakdown(10000, 7, LEGACY_TERMS_VERSION)).toMatchObject({ serviceFeeSats: 100, totalSats: 10107 })
    expect(feeBreakdown(101,0,LEGACY_TERMS_VERSION).serviceFeeSats).toBe(2)
    expect(feeBreakdown(1,0,LEGACY_TERMS_VERSION).totalSats).toBe(2)
  })
  it('uses exact decimal paise and fixed rates', () => {
    expect(decimalUnits('0.29')).toBe(29n)
    expect(quotePrice({ inr: '0.29', rateType: 'fixed', fixedRate: '100', now: 0 }).payerSats).toBe(29)
    expect(() => decimalUnits('1.001')).toThrow()
  })
  it('allows arbitrary premiums and discounts without consulting trust', () => {
    const args = { inr: '500', rateType: 'market', reference: { inr: 10000000, at: 0 }, now: 1 }
    expect(quotePrice({ ...args, premium: '10' }).payerSats).toBe(5500)
    expect(quotePrice({ ...args, premium: '-10' }).payerSats).toBe(4500)
    expect(quotePrice({ ...args, premium: '1000' }).payerSats).toBe(55000)
    expect(() => quotePrice({ ...args, premium: '-100' })).toThrow()
  })
  it('rejects stale, future and absent references without silently substituting a price', () => {
    for (const reference of [null, { inr: 10000000, at: 0 }, { inr: 10000000, at: 300001 }])
      expect(() => quotePrice({ inr: '500', rateType: 'market', reference, now: 300000 })).toThrow()
  })
  it('rejects unsafe totals and fractional fees and keeps quotes immutable', () => {
    expect(() => feeBreakdown(Number.MAX_SAFE_INTEGER,1)).toThrow()
    expect(() => feeBreakdown(100, 0.1)).toThrow()
    const q = quotePrice({ inr: '500', rateType: 'fixed', fixedRate: '10', now: 0 })
    expect(q.totalSats).toBe(5000)
    expect(q.expiresAt).toBe(300000)
    expect(Object.isFrozen(q)).toBe(true)
  })
})
