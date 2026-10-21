import { expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { sealAttachment, uploadAttachment, openAttachment, validateManifest, MAX_EVIDENCE_BYTES } from './evidence.js'
import { SUGGESTED_SERVERS } from '../recovery.js'
import { blossom, PNG } from './evidence.fixture.js'

const sk = generateSecretKey(), signer = { pubkey: getPublicKey(sk), sign: async t => finalizeEvent(t, sk) }

it('encrypts evidence per file, stores verified copies, and decrypts only with the manifest key', async () => {
  const host = blossom()
  const manifest = await uploadAttachment(await sealAttachment(PNG, 'image/png', 'upi screenshot.png'), SUGGESTED_SERVERS, signer, host.fetcher)
  expect(validateManifest(manifest)).toBe(true)
  expect([...host.blobs.values()][0]).not.toEqual(PNG)
  const blob = await openAttachment(manifest, host.fetcher)
  expect([blob.type, new Uint8Array(await blob.arrayBuffer())]).toEqual(['image/png', PNG])
  // One corrupted copy is skipped; all corrupted fails.
  const [first, ...rest] = [...host.blobs.keys()]
  host.blobs.set(first, new Uint8Array([1, 2, 3]))
  expect((await openAttachment(manifest, host.fetcher)).size).toBe(PNG.length)
  for (const key of rest) host.blobs.set(key, new Uint8Array([1]))
  await expect(openAttachment(manifest, host.fetcher)).rejects.toThrow('No copy')
  await expect(openAttachment({ ...manifest, key: '0'.repeat(64) }, blossom().fetcher)).rejects.toThrow()
})
it('accepts only real images and PDFs, so disguised HTML or SVG never runs', async () => {
  const text = s => new TextEncoder().encode(s)
  await expect(sealAttachment(text('<svg onload=alert(1)>'), 'image/svg+xml')).rejects.toThrow('PNG')
  await expect(sealAttachment(text('<html><script>'), 'text/html')).rejects.toThrow('PNG')
  await expect(sealAttachment(text('<svg onload=alert(1)>'), 'image/png')).rejects.toThrow('do not match')
  await expect(sealAttachment(text('RIFF0000WAVE'), 'image/webp')).rejects.toThrow('do not match')
  await expect(sealAttachment(new Uint8Array(MAX_EVIDENCE_BYTES + 1).fill(0x25), 'application/pdf')).rejects.toThrow('5 MB')
  expect((await sealAttachment(text('%PDF-1.7'), 'application/pdf')).manifest.type).toBe('application/pdf')
})
it('requires two verified copies and rejects malformed manifests', async () => {
  const sealed = await sealAttachment(PNG, 'image/png')
  await expect(uploadAttachment(sealed, SUGGESTED_SERVERS, signer, blossom(SUGGESTED_SERVERS.slice(1)).fetcher)).rejects.toThrow('two evidence copies')
  const good = await uploadAttachment(sealed, SUGGESTED_SERVERS, signer, blossom().fetcher)
  for (const bad of [{ ...good, extra: 1 }, { ...good, servers: ['http://insecure.example'] }, { ...good, type: 'text/html' }, { ...good, size: MAX_EVIDENCE_BYTES + 1 }]) expect(validateManifest(bad)).toBe(false)
})
