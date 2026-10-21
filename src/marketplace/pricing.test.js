import { describe, expect, it } from 'vitest'
import { decimalUnits, costBreakdown, quotePrice } from './pricing.js'

describe('locked marketplace prices', () => {
  it('charges no platform fee: total is payer sats plus disclosed mint costs', () => {
    expect(costBreakdown(10000,7)).toEqual({payerSats:10000,fundingFeeSats:7,totalSats:10007})
    expect(Object.keys(costBreakdown(1))).not.toContain('serviceFeeSats')
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
    expect(() => costBreakdown(Number.MAX_SAFE_INTEGER,1)).toThrow()
    expect(() => costBreakdown(100, 0.1)).toThrow()
    const q = quotePrice({ inr: '500', rateType: 'fixed', fixedRate: '10', now: 0 })
    expect(q.totalSats).toBe(5000)
    expect(q.expiresAt).toBe(300000)
    expect(Object.isFrozen(q)).toBe(true)
  })
})
