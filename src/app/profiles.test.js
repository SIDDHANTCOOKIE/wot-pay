import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { readProfiles, profilePicture } from './profiles.js'
const sk = generateSecretKey(), pubkey = getPublicKey(sk)
const event = (content, time = 1, kind = 0) => finalizeEvent({ kind, content: JSON.stringify(content), tags: [], created_at: time }, sk)
describe('profile metadata', () => {
  it('uses latest valid kind 0 display name and picture, not kind 1 notes', () => {
    const p = readProfiles([event({ name: 'old' }), event({ display_name: 'New', picture: 'https://example.com/p.png' }, 2), event({ name: 'note' }, 3, 1)], [pubkey], 10)
    expect(p[pubkey]).toEqual({ name: 'New', picture: 'https://example.com/p.png' })
  })
  it('rejects changed signatures, unrelated authors and future events', () => {
    const bad = event({ name: 'bad' }); bad.content = '{}'
    expect(readProfiles([bad, event({ name: 'future' }, 1000)], [pubkey], 10)).toEqual({})
    expect(readProfiles([event({ name: 'other' })], ['ab'.repeat(32)], 10)).toEqual({})
  })
  it('uses name fallback and keeps empty metadata safe', () => {
    expect(readProfiles([event({ display_name: '', name: ' Name ' })], [pubkey], 10)[pubkey].name).toBe('Name')
    expect(readProfiles([event({ name: 'x'.repeat(257) })], [pubkey], 10)[pubkey].name).toBe('')
  })
  it('ignores malformed events without losing valid profiles', () => {
    expect(readProfiles([null, {}, { kind: 0, pubkey, tags: null }, event({ name: 'valid' })], [pubkey], 10)[pubkey].name).toBe('valid')
  })
  it('rejects unsafe picture URLs and credentials', () => {
    for (const url of ['javascript:alert(1)', 'http://example.com/a', 'data:image/png;base64,xyz', 'https://u:p@example.com/a', 'bad']) expect(profilePicture(url)).toBe('')
  })
})
