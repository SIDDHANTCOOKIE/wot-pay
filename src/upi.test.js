import { describe, it, expect } from 'vitest'
import { parseUpi, upiLink } from './upi.js'

describe('upi', () => {
  it('parses a merchant QR', () => {
    expect(parseUpi('upi://pay?pa=chai.stall@okaxis&pn=Chai%20Stall&am=40.00&cu=INR')).toEqual({
      vpa: 'chai.stall@okaxis', payee: 'Chai Stall', inr: 40, note: undefined,
    })
  })

  it('amount is optional (static QR)', () => {
    expect(parseUpi('UPI://pay?pa=someone@ybl').inr).toBeUndefined()
  })

  it('rejects non-UPI and foreign currency', () => {
    expect(parseUpi('https://example.com')).toBeNull()
    expect(parseUpi('upi://pay?pn=x')).toBeNull()
    expect(parseUpi('upi://pay?pa=a@upi&cu=USD')).toBeNull()
  })

  it('round-trips through upiLink', () => {
    const p = { vpa: 'a.b@okicici', payee: 'A B', inr: 99.5 }
    expect(parseUpi(upiLink(p))).toMatchObject(p)
  })
})
