import { it, expect } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { safeRelay, writeRelays } from './identity-relays.js'
const sk = generateSecretKey(), pk = getPublicKey(sk)
const ev = (tags, time=1) => finalizeEvent({kind:10002, content:'', tags, created_at:time}, sk)
it('uses only the latest signed owner write relays, with a cap', () => {
 expect(writeRelays([ev([['r','wss://old.example']]), ev([['r','wss://read.example','read'],['r','wss://write.example','write'],['r','wss://both.example']],2)], pk, 10)).toEqual(['wss://write.example/','wss://both.example/'])
 expect(writeRelays([ev(Array.from({length:10}, (_,i)=>['r',`wss://r${i}.example`]))],pk,10)).toHaveLength(6)
})
it('rejects altered, unrelated and future relay lists', () => {
 const bad=ev([['r','wss://bad.example']]);bad.content='changed'
 expect(writeRelays([bad,ev([['r','wss://future.example']],1000),null],pk,10)).toEqual([])
 expect(writeRelays([ev([['r','wss://other.example']])],'ab'.repeat(32),10)).toEqual([])
})
it('rejects unsafe URLs, IP and local destinations', () => {
 for(const u of ['ws://a.example','wss://127.0.0.1','wss://[::1]','wss://localhost','wss://x.local','wss://u:p@a.example','wss://a.example:8080'])expect(safeRelay(u)).toBeNull()
 expect(safeRelay('wss://relay.example/path')).toBe('wss://relay.example/path')
})
it('discovers outbox for identity reads without changing publish destinations', async () => {
 const { createRelayClient } = await import('./relays.js')
 const queries=[], pubs=[], closed=[]
 const pool={querySync:async (urls,f)=>{queries.push([urls,f]);return f.kinds[0]===10002 ? [ev([['r','wss://outbox.example','write']])] : []},publish:(urls)=>{pubs.push(urls);return [Promise.resolve()]},close:urls=>closed.push(urls)}
 const c=createRelayClient({relays:['wss://board.example'],pool})
 await c.queryIdentity({kinds:[0],authors:[pk]},{discover:true})
 await c.queryIdentity({kinds:[3],authors:[pk]},{discover:true})
 expect(queries.filter(([,f])=>f.kinds[0]===10002)).toHaveLength(1)
 expect(queries.at(-1)[0]).toContain('wss://outbox.example/')
 await c.publish(ev([]));expect(pubs[0]).toEqual(['wss://board.example'])
 c.close();expect(closed[0]).toContain('wss://outbox.example/')
})
it('uses the viewers discovered relays for batched other-author metadata',async()=>{
 const {createRelayClient}=await import('./relays.js');const queries=[]
 const c=createRelayClient({pool:{querySync:async(urls,f)=>{queries.push({urls,f});return f.kinds[0]===10002?[ev([['r','wss://viewer-outbox.example']])]:[]},close:()=>{}}})
 const authors=['ab'.repeat(32),'cd'.repeat(32)]
 await c.queryIdentity({kinds:[0],authors},{discover:true,relayOwner:pk})
 expect(queries[0].f.authors).toEqual([pk])
 expect(queries[1].f.authors).toEqual(authors)
 for(const url of ['wss://viewer-outbox.example/','wss://purplepag.es','wss://nostr-01.yakihonne.com'])expect(queries[1].urls).toContain(url)
})
