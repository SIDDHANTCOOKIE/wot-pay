import { expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent, getEventHash } from 'nostr-tools/pure'
import { createWrap } from 'nostr-tools/nip59'
import * as nip44 from 'nostr-tools/nip44'
import { testTrade } from './fixtures.js'
import { wrapPrivate, openPrivate, wrapPrivateWith, openPrivateWith } from './private.js'
import { withMarketplace } from './remote-signer.js'
import { externalSigner } from './external-signer.fixture.js'

it('builds NIP-17 wraps that interoperate with device keys in both directions', async () => {
  const t = await testTrade()
  const requester = externalSigner(t.identities.requester.sk), payerSk = t.identities.payer.sk
  const fromRemote = t.sign('requester', 'evidence', { note: 'remote to local' })
  const wrap = await requester.signer.wrapPrivate(t.agreement.payer, fromRemote)
  expect(wrap.content).not.toContain('remote to local')
  expect(openPrivate(payerSk, wrap)?.id).toBe(fromRemote.id)
  const fromLocal = t.sign('payer', 'evidence', { note: 'local to remote' })
  expect((await requester.signer.openPrivate(wrapPrivate(payerSk, t.agreement.requester, fromLocal)))?.id).toBe(fromLocal.id)
  expect(await externalSigner().signer.openPrivate(wrap)).toBeNull()
})
it('rejects a seal whose signer is not the claimed author, and a rumor that does not hash', async () => {
  const t = await testTrade(), victim = t.agreement.requester, attacker = generateSecretKey()
  const recipient = externalSigner(t.identities.payer.sk)
  const forge = async (rumorPatch = {}) => {
    const rumor = { created_at: 1, kind: 14, tags: [['p', t.agreement.payer], ['subject', 'wot-pay-v3:trade']], content: JSON.stringify(t.sign('requester', 'evidence', {})), pubkey: victim }
    rumor.id = getEventHash(rumor)
    Object.assign(rumor, rumorPatch)
    const seal = finalizeEvent({ kind: 13, created_at: 1, tags: [], content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(attacker, t.agreement.payer)) }, attacker)
    return createWrap(seal, t.agreement.payer)
  }
  expect(await openPrivateWith(recipient.crypto44, await forge())).toBeNull()
  const own = externalSigner(t.identities.requester.sk)
  const wrap = await wrapPrivateWith(own.signer, own.crypto44, t.agreement.payer, t.sign('requester', 'evidence', {}))
  expect(await openPrivateWith(recipient.crypto44, { ...wrap, content: wrap.content.slice(0, -4) + 'AAAA' })).toBeNull()
})
it('keeps one vault key per identity, never replaces one it cannot open, and restores from a kit', async () => {
  const sk = generateSecretKey(), storage = new Map()
  const first = externalSigner(sk, storage).signer
  const sealed = await first.sealLocal({ secret: 'escrow key' })
  const again = externalSigner(sk, storage).signer
  expect(await again.openLocal(sealed)).toEqual({ secret: 'escrow key' })
  const slot = [...storage.keys()][0], key = await first.vaultKey()
  storage.set(slot, 'corrupted')
  const broken = externalSigner(sk, storage).signer
  await expect(broken.openLocal(sealed)).rejects.toThrow('Restore your recovery kit')
  expect(storage.get(slot)).toBe('corrupted')
  await broken.importVaultKey(key)
  expect(await broken.openLocal(sealed)).toEqual({ secret: 'escrow key' })
  expect(withMarketplace({ pubkey: 'x' }, null).sealLocal).toBeUndefined()
})
it('sends notices any NIP-17 client can read, which wot-pay itself ignores', async () => {
  const { unwrapEvent } = await import('nostr-tools/nip17')
  const { wrapNotice } = await import('./private.js')
  const t = await testTrade(), remote = externalSigner(t.identities.requester.sk)
  for (const wrap of [await remote.signer.wrapNotice(t.agreement.payer, 'wot-pay: hello'), wrapNotice(t.identities.requester.sk, t.agreement.payer, 'wot-pay: hello')]) {
    const rumor = unwrapEvent(wrap, t.identities.payer.sk)
    expect([rumor.kind, rumor.content, rumor.pubkey, rumor.tags.some(x => x[0] === 'subject')]).toEqual([14, 'wot-pay: hello', t.agreement.requester, false])
    expect(openPrivate(t.identities.payer.sk, wrap)).toBeNull()
  }
  await expect(remote.signer.wrapNotice(t.agreement.payer, '')).rejects.toThrow()
})
