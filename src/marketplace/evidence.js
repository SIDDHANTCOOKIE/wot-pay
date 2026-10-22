import { readVerified, replicateBackup } from '../recovery.js'

// Private case evidence (screenshots, statements) too big for a message. Each
// file is encrypted with its own random key and stored on the sender's three
// Blossom hosts; only a small manifest with that key travels inside the
// encrypted trade message, so only the trade's participants and arbitrator
// can open it. Only plain images and PDFs are accepted, checked against the
// file's real bytes, so a disguised HTML or SVG file can never run.
export const EVIDENCE_TYPES = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/webp': [0x52, 0x49, 0x46, 0x46], 'application/pdf': [0x25, 0x50, 0x44, 0x46] }
export const MAX_EVIDENCE_BYTES = 5_000_000
export const MAX_ATTACHMENTS = 6
const AAD = new TextEncoder().encode('wot-pay:evidence:v1')
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
const unhex = text => Uint8Array.from(text.match(/../g), h => parseInt(h, 16))

function checkFile(bytes, type) {
  const magic = EVIDENCE_TYPES[type]
  if (!magic) throw new Error('Attach a PNG, JPEG, WebP image or a PDF.')
  if (!bytes.byteLength || bytes.byteLength > MAX_EVIDENCE_BYTES) throw new Error('Evidence files must be under 5 MB.')
  const webp = type !== 'image/webp' || String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  if (!webp || magic.some((b, i) => bytes[i] !== b)) throw new Error('The file contents do not match its type.')
}

export async function sealAttachment(bytes, type, name = 'evidence') {
  checkFile(bytes, type)
  const key = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12))
  const aes = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt'])
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, aes, bytes))
  return { ciphertext, manifest: { name: String(name).replace(/[^\w .()-]/g, '_').slice(0, 120) || 'evidence', type, size: bytes.byteLength, key: hex(key), iv: hex(iv) } }
}

// Uploads to the sender's recovery hosts; two verified copies are required.
export async function uploadAttachment(sealed, servers, signer, fetcher = fetch) {
  const result = await replicateBackup({ bytes: sealed.ciphertext, servers, signer, fetcher })
  const stored = result.results.filter(r => r.verified).map(r => r.server)
  if (stored.length < 2) throw new Error('Fewer than two evidence copies verified. The file was not shared.')
  return { ...sealed.manifest, hash: result.hash, servers: stored }
}

export function validateManifest(m) {
  const keys = ['name', 'type', 'size', 'key', 'iv', 'hash', 'servers']
  if (!m || typeof m !== 'object' || Object.keys(m).length !== keys.length || !keys.every(k => k in m)) return false
  try {
    return typeof m.name === 'string' && m.name.length <= 120 && m.type in EVIDENCE_TYPES && Number.isSafeInteger(m.size) && m.size > 0 && m.size <= MAX_EVIDENCE_BYTES
      && /^[0-9a-f]{64}$/.test(m.key) && /^[0-9a-f]{24}$/.test(m.iv) && /^[0-9a-f]{64}$/.test(m.hash)
      && Array.isArray(m.servers) && m.servers.length >= 1 && m.servers.length <= 3 && m.servers.every(s => { const u = new URL(s); return u.protocol === 'https:' && u.origin === s })
  } catch { return false }
}

// Fetches from any listed host, verifies the hash, decrypts and re-checks the
// contents before handing back a Blob of the declared safe type.
export async function openAttachment(manifest, fetcher = fetch) {
  if (!validateManifest(manifest)) throw new Error('Invalid evidence attachment.')
  const aes = await crypto.subtle.importKey('raw', unhex(manifest.key), 'AES-GCM', false, ['decrypt'])
  for (const server of manifest.servers) {
    try {
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(manifest.iv), additionalData: AAD }, aes, await readVerified(server, manifest.hash, fetcher)))
      if (plain.byteLength !== manifest.size) continue
      checkFile(plain, manifest.type)
      return new Blob([plain], { type: manifest.type })
    } catch { /* Try the next copy. */ }
  }
  throw new Error('No copy of this evidence could be verified. Ask the sender to share it again.')
}

