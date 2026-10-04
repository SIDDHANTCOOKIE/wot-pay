import { describe, it, expect } from 'vitest'
import { mergeFollows, latestFollow } from './follows.js'
const A = 'a'.repeat(64),
  B = 'b'.repeat(64),
  C = 'c'.repeat(64)
const old = {
  kind: 3,
  pubkey: A,
  id: 'a',
  created_at: 1,
  tags: [
    ['p', B, 'wss://example'],
    ['x', 'keep'],
  ],
  content: '{"keep":true}',
}
describe('follow-list merge', () => {
  it('preserves follows, extra tag fields and metadata on addition', () => {
    const t = mergeFollows(old, A, [C])
    expect(t.tags).toEqual([...old.tags, ['p', C]])
    expect(t.content).toBe(old.content)
  })
  it('removes only the explicitly requested person', () =>
    expect(mergeFollows(old, A, [], [B]).tags).toEqual([['x', 'keep']]))
  it('deduplicates an existing addition', () => expect(mergeFollows(old, A, [B]).tags).toEqual(old.tags))
  it('refuses edits to someone else or invalid keys', () => {
    expect(() => mergeFollows(old, B, [C])).toThrow()
    expect(() => mergeFollows(old, A, ['bad'])).toThrow()
  })
  it('selects newest owner list', () =>
    expect(latestFollow([old, { ...old, id: 'b', created_at: 2 }], A).id).toBe('b'))
})
