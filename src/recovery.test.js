import { expect, it } from 'vitest'
import { makeRecoveryKit, openRecoveryKit, encryptBackup, decryptBackup, newRecoverySecret, recoveryServers, replicateBackup, recoverRemote } from './recovery.js'
const servers = ['https://one.example', 'https://two.example', 'https://three.example']
it('restores an authenticated encrypted kit, rejects corruption and wrong secrets', async () => {
  const payload = { owner: 'alice', escrowKeys: ['private'], proofs: ['secret'], revision: 3 }
  const kit = await makeRecoveryKit(payload)
  expect(kit.encryptedBackup).not.toContain('private')
  expect(await openRecoveryKit(kit)).toEqual(payload)
  await expect(openRecoveryKit({ ...kit, secret: newRecoverySecret() })).rejects.toThrow()
  await expect(openRecoveryKit({ ...kit, encryptedBackup: kit.encryptedBackup + ' ' })).rejects.toThrow('Damaged')
  const secret = newRecoverySecret()
  expect(await encryptBackup(payload, secret)).not.toEqual(await encryptBackup(payload, secret))
})
it('does not count three paths on one host as redundant copies', () => {
  expect(() => recoveryServers(['https://one.example', 'https://one.example', 'https://two.example'])).toThrow()
  expect(() => recoveryServers(['http://one.example', ...servers.slice(1)])).toThrow()
})
it('verifies full readback, tolerates one failed host and repairs missing replicas', async () => {
  const kit = await makeRecoveryKit({ revision: 1 }, servers)
  const bytes = new TextEncoder().encode(kit.encryptedBackup)
  const stored = new Map()
  let offline = true
  const fetcher = async (url, options) => {
    const host = new URL(url).origin
    if (host === servers[0] && offline) throw new Error('offline')
    if (options.method === 'PUT') { stored.set(host, options.body); return new Response('{}') }
    return stored.has(host) ? new Response(stored.get(host)) : new Response('', { status: 404 })
  }
  const signer = { sign: async event => event }
  const result = await replicateBackup({ bytes, servers, signer, fetcher })
  expect(result.verifiedCopies).toBe(2)
  expect(await recoverRemote({ servers, hash: kit.hash, secret: kit.secret, fetcher })).toEqual({ revision: 1 })
  offline = false
  expect((await replicateBackup({ bytes, servers, signer, fetcher })).verifiedCopies).toBe(3)
})
it('does not trust an upload receipt when the server returns different bytes', async () => {
  const bytes = await encryptBackup({ revision: 1 }, newRecoverySecret())
  const result = await replicateBackup({ bytes, servers, signer: { sign: async e => e }, fetcher: async () => new Response('wrong bytes') })
  expect(result.verifiedCopies).toBe(0)
  await expect(decryptBackup(bytes, newRecoverySecret())).rejects.toThrow()
})
it('rejects hosts known to share an operator and accepts the suggested independent set', async () => {
  const { recoveryServers, SUGGESTED_SERVERS } = await import('./recovery.js')
  expect(recoveryServers(SUGGESTED_SERVERS)).toEqual(SUGGESTED_SERVERS)
  expect(() => recoveryServers(['https://blossom.nostr.build', 'https://blossom.band', 'https://blossom.primal.net'])).toThrow('same operator')
})
it('follows CDN redirects on read because the bytes are hash-verified', async () => {
  const { recoverRemote, encryptBackup, digest, newRecoverySecret, SUGGESTED_SERVERS } = await import('./recovery.js')
  const secret = newRecoverySecret(), bytes = await encryptBackup({ ok: true }, secret), hash = await digest(bytes)
  const seen = []
  const fetcher = async (url, options) => { seen.push(options.redirect); return new Response(url.startsWith(SUGGESTED_SERVERS[0]) ? bytes : new Uint8Array([1, 2, 3])) }
  expect(await recoverRemote({ servers: SUGGESTED_SERVERS, hash, secret, fetcher })).toEqual({ ok: true })
  expect(seen[0]).toBe('follow')
  const tampered = async () => new Response(new Uint8Array([9]))
  await expect(recoverRemote({ servers: SUGGESTED_SERVERS, hash, secret, fetcher: tampered })).rejects.toThrow()
})
