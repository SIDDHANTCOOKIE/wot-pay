// Public events may carry a mint URL and a receive method, never a Cashu token.
// A token is bearer money: anyone reading a relay can redeem it.

// cashuA (v3, base64url JSON) and cashuB (v4, base64url CBOR), optional cashu: URI prefix.
export const TOKEN_STRING = /cashu[AB][A-Za-z0-9_\-+/=]{16,}/i

function isProof(v) {
  return v && typeof v === 'object' && 'secret' in v && ('C' in v || 'c' in v)
}

function scan(value, path, depth = 0) {
  if (depth > 20) return null
  if (typeof value === 'string') {
    if (TOKEN_STRING.test(value)) return path
    const t = value.trim()
    if ((t.startsWith('{') || t.startsWith('[')) && t.length < 200000) {
      try {
        return scan(JSON.parse(t), path, depth + 1)
      } catch {
        return null
      }
    }
    return null
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = scan(value[i], `${path}[${i}]`, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (value && typeof value === 'object') {
    if (isProof(value)) return path
    if (Array.isArray(value.proofs) && value.proofs.some(isProof)) return path
    for (const [k, v] of Object.entries(value)) {
      const hit = scan(v, `${path}.${k}`, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

export class TokenLeakError extends Error {
  constructor(where) {
    super(`refusing to publish: token-shaped value at ${where}`)
    this.name = 'TokenLeakError'
    this.where = where
  }
}

// Returns the path of the first token-shaped value, or null.
export function findToken(event) {
  return scan(event?.content ?? '', 'content') || scan(event?.tags ?? [], 'tags')
}

export function assertNoToken(event) {
  const where = findToken(event)
  if (where) throw new TokenLeakError(where)
}
