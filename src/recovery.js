const encoder = new TextEncoder()
const decoder = new TextDecoder()
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
function unhex(value, length) {
  if (typeof value !== 'string' || !/^[0-9a-f]+$/.test(value) || value.length % 2 || (length && value.length !== length * 2)) throw new Error('Invalid recovery data.')
  return Uint8Array.from(value.match(/../g), pair => parseInt(pair, 16))
}
export const digest = async bytes => hex(await crypto.subtle.digest('SHA-256', bytes))
const aad = encoder.encode('wot-pay:recovery:v1')
export const newRecoverySecret = () => hex(crypto.getRandomValues(new Uint8Array(32)))

export async function encryptBackup(data, secret) {
  const key = await crypto.subtle.importKey('raw', unhex(secret, 32), 'AES-GCM', false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, encoder.encode(JSON.stringify(data)))
  return encoder.encode(JSON.stringify({ version: 1, iv: hex(iv), ciphertext: hex(ciphertext) }))
}

export async function decryptBackup(bytes, secret) {
  if (bytes.byteLength > 20_000_000) throw new Error('Backup is too large.')
  const envelope = JSON.parse(decoder.decode(bytes))
  if (envelope.version !== 1) throw new Error('Unsupported backup version.')
  const key = await crypto.subtle.importKey('raw', unhex(secret, 32), 'AES-GCM', false, ['decrypt'])
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(envelope.iv, 12), additionalData: aad }, key, unhex(envelope.ciphertext))
  return JSON.parse(decoder.decode(clear))
}

// Hostnames are not operators: one operator can serve several hosts (in
// October 2026 blossom.nostr.build and blossom.band returned identical
// operator-specific headers). Hosts known to share an operator are rejected
// together. Unknown hosts still need the user's own judgement.
export const KNOWN_OPERATORS = { 'blossom.nostr.build': 'nostr.build', 'blossom.band': 'nostr.build', 'nostr.build': 'nostr.build', 'blossom.primal.net': 'Primal', 'cdn.satellite.earth': 'Satellite', 'blossom.yakihonne.com': 'YakiHonne' }
// Suggestions only, from three different operators whose browser CORS allowed
// uploads when checked. Saving uploads and reads back the encrypted backup,
// which is the real test; replace any host that fails or that you do not trust.
export const SUGGESTED_SERVERS = ['https://blossom.primal.net', 'https://blossom.nostr.build', 'https://cdn.satellite.earth']
const operatorOf = host => KNOWN_OPERATORS[host] || host

export function recoveryServers(values) {
  const urls = values.map(value => {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use HTTPS Blossom server origins without paths or credentials.')
    return url.origin
  })
  if (urls.length !== 3 || new Set(urls.map(value => new URL(value).hostname)).size !== 3) throw new Error('Choose three different Blossom server hosts, run by independent operators.')
  if (new Set(urls.map(value => operatorOf(new URL(value).hostname))).size !== 3) throw new Error('Two of these hosts are run by the same operator. Choose three independent operators.')
  return urls
}

export async function readVerified(server, hash, fetcher) {
  // Blossom may redirect reads to a CDN (BUD-01). Following is safe because
  // the bytes are checked against the expected SHA-256 below.
  const response = await fetcher(`${server}/${hash}`, { signal: AbortSignal.timeout(15000), credentials: 'omit', cache: 'no-store', redirect: 'follow' })
  if (!response.ok) throw new Error('Backup is not retrievable.')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Backup response has no body.')
  const chunks = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > 20_000_000) { await reader.cancel(); throw new Error('Backup is too large.') }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  if (await digest(bytes) !== hash) throw new Error('Backup hash does not match.')
  return bytes
}

// Same encrypted bytes on all hosts. A server's upload acknowledgement alone
// does not count: fetch the blob back and verify its content hash.
export async function replicateBackup({ bytes, servers, signer, fetcher = fetch }) {
  const origins = recoveryServers(servers)
  const hash = await digest(bytes)
  const results = []
  // Sign sequentially so external signer permission prompts do not overlap.
  for (const server of origins) {
    try {
      try { await readVerified(server, hash, fetcher) }
      catch {
        const now = Math.floor(Date.now() / 1000)
        const auth = await signer.sign({ kind: 24242, created_at: now, content: 'Upload encrypted wot-pay recovery backup', tags: [['t', 'upload'], ['x', hash], ['server', new URL(server).hostname], ['expiration', String(now + 300)]] })
        const encoded = btoa(JSON.stringify(auth)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
        const response = await fetcher(`${server}/upload`, { method: 'PUT', body: bytes, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/octet-stream', 'X-SHA-256': hash, Authorization: `Nostr ${encoded}` } })
        if (!response.ok) throw new Error(`Upload rejected (${response.status}).`)
        await readVerified(server, hash, fetcher)
      }
      results.push({ server, verified: true })
    } catch (error) { results.push({ server, verified: false, error: error.message }) }
  }
  return { hash, results, verifiedCopies: results.filter(r => r.verified).length, checkedAt: Date.now() }
}

export async function recoverRemote({ servers, hash, secret, fetcher = fetch }) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid backup hash.')
  for (const server of recoveryServers(servers)) {
    try { return await decryptBackup(await readVerified(server, hash, fetcher), secret) } catch { /* Try another replica. */ }
  }
  throw new Error('No valid replica could be decrypted. Check the recovery secret or use your downloaded backup.')
}

export async function makeRecoveryKit(data, servers = []) {
  const secret = newRecoverySecret()
  const bytes = await encryptBackup(data, secret)
  return { version: 1, createdAt: Date.now(), secret, servers, hash: await digest(bytes), encryptedBackup: decoder.decode(bytes) }
}

export async function openRecoveryKit(kit) {
  if (kit.version !== 1 || typeof kit.encryptedBackup !== 'string') throw new Error('Invalid recovery kit.')
  const bytes = encoder.encode(kit.encryptedBackup)
  if (await digest(bytes) !== kit.hash) throw new Error('Damaged recovery kit.')
  return decryptBackup(bytes, kit.secret)
}
