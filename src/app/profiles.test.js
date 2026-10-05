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
    for (const url of ['javascript:alert(1)', 'http://example.com/a', 'data:image/png;base64,xyz', 'https://u:p@example.com/a', 'bad', 'https://localhost/a', 'https://127.0.0.1/a', 'https://x.internal/a']) expect(profilePicture(url)).toBe('')
  })
})

it('rejects oversized profile content before parsing',()=>{
 const oversized=event({name:'x'.repeat(16001)})
 expect(readProfiles([oversized],[pubkey],10)).toEqual({})
})

it('chunks and caps metadata reads with at most two concurrent queries', async () => {
 const {loadProfiles}=await import('./profiles.js')
 const authors=Array.from({length:650},(_,i)=>i.toString(16).padStart(64,'0'))
 let active=0, max=0;const calls=[]
 const client={queryIdentity:async(f,options)=>{active++;max=Math.max(max,active);calls.push({f,options});await new Promise(r=>setTimeout(r,1));active--;return []}}
 expect(await loadProfiles(client,[...authors,authors[0],'invalid'],{owner:pubkey})).toEqual({})
 expect(calls).toHaveLength(5);expect(max).toBe(2)
 expect(calls.every(({f,options})=>f.authors.length<=100&&options.relayOwner===pubkey&&options.maxWait===3000)).toBe(true)
})
it('metadata failures leave the npub fallback available',async()=>{
 const {loadProfiles}=await import('./profiles.js')
 expect(await loadProfiles({queryIdentity:async()=>{throw Error('offline')}},[pubkey])).toEqual({})
})
