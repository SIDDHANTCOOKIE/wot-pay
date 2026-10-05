import { describe, it, expect } from 'vitest'
import { exposureWarning } from './exposure.js'

describe('start-small exposure reminder', () => {
  it('warns even for a direct follow with zero settled claims', () => {
    expect(exposureWarning({ hops: 1, score: 1, settles: 0, disputes: 0 })).toContain('Start small')
  })
  it('does not treat reciprocal follows or a high score as settled history', () => {
    expect(exposureWarning({ hops: 1, score: 10, settles: 0 })).toContain('not payment proof')
  })
  it('warns for outsiders and missing counted history', () => {
    expect(exposureWarning({ hops: null })).toContain('No settled trade claims')
    expect(exposureWarning(undefined)).toContain('No settled trade claims')
  })
  it('suppresses the zero-history assertion while history loads', () => {
    expect(exposureWarning({ settles: 0 }, true)).toBeNull()
  })
  it('does not show a zero-history warning when any settled weight is counted', () => {
    expect(exposureWarning({ settles: 1 })).toBeNull()
    expect(exposureWarning({ settles: 0.5, disputes: 2 })).toBeNull()
  })
  it('does not let disputes stand in for settled history', () => {
    expect(exposureWarning({ settles: 0, disputes: 3 })).toContain('Start small')
  })
})
