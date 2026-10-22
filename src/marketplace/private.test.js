import { expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { finalizeEvent } from 'nostr-tools/pure'
import { testTrade } from './fixtures.js'
import { wrapPrivate, openPrivate, inboxRelays, deliverPrivate } from './private.js'
import { createVault } from './vault.js'
import { encryptBackup, decryptBackup, newRecoverySecret } from '../recovery.js'

it('encrypts agreement messages to the selected recipient and rejects third-party decryption', async () => {
  const { sign, identities } = await testTrade()
  const signed = sign('requester', 'evidence', { note: 'Private payment evidence' })
  const wrapped = wrapPrivate(identities.requester.sk, identities.payer.pubkey, signed)
  expect(wrapped.content).not.toContain('Private payment evidence')
  expect(openPrivate(identities.payer.sk,wrapped)?.id).toBe(signed.id)
  expect(openPrivate(identities.arbitrator.sk,wrapped)).toBeNull()
})
it('encrypts persisted secrets, preserves revisions and retries identical gift-wrap ids', async () => {
  const { sign, identities } = await testTrade()
  const secret = newRecoverySecret()
  const signer = { ...identities.requester, sealLocal: value => encryptBackup(value,secret), openLocal: bytes => decryptBackup(bytes,secret), wrapPrivate: (to,event) => wrapPrivate(identities.requester.sk,to,event) }
  const db = new IDBFactory(), vault = createVault(signer,db)
  const first = await vault.write('trade', { secret: 'escrow key' })
  await vault.write('trade', { secret: 'new key' },first.revision)
  await expect(vault.write('trade', { secret: 'lost key' },first.revision)).rejects.toThrow('another tab')
  expect((await createVault(signer,db).read('trade')).value.secret).toBe('new key')
  const inbox = finalizeEvent({ kind:10050,created_at:Math.floor(Date.now()/1000),content:'',tags:[['relay','wss://inbox.example']] },identities.payer.sk)
  expect(inboxRelays([inbox],identities.payer.pubkey)).toEqual(['wss://inbox.example'])
  const attempts=[]
  const client={queryIdentity:async()=>[inbox],publishTo:async(relays,wrap)=>{attempts.push(wrap.id);if(attempts.length===1)throw new Error('lost ack')}}
  const args={client,signer,vault,to:identities.payer.pubkey,signed:sign('requester','accept')}
  await expect(deliverPrivate(args)).rejects.toThrow('lost ack')
  await deliverPrivate(args)
  expect(attempts[0]).toBe(attempts[1])
})
it('refuses a message too large for relays before saving it to the outbox', async () => {
  const { MAX_WRAP_BYTES } = await import('./private.js')
  const { sign, identities } = await testTrade()
  const secret = newRecoverySecret()
  const signer = { ...identities.requester, sealLocal: value => encryptBackup(value,secret), openLocal: bytes => decryptBackup(bytes,secret), wrapPrivate: (to,event) => wrapPrivate(identities.requester.sk,to,event) }
  const vault = createVault(signer,new IDBFactory()), huge = sign('requester','evidence',{ note: '"'.repeat(20000) })
  expect(JSON.stringify(wrapPrivate(identities.requester.sk,identities.payer.pubkey,huge)).length).toBeGreaterThan(MAX_WRAP_BYTES)
  await expect(deliverPrivate({ client: {}, signer, vault, to: identities.payer.pubkey, signed: huge })).rejects.toThrow('too large')
  expect(await vault.read(`outbox:${huge.id}:${identities.payer.pubkey}`)).toBeNull()
})
