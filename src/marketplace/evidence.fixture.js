// In-memory Blossom host and a minimal PNG for evidence tests; never used by the app.
export const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
export function blossom(down = []) {
  const blobs = new Map()
  const fetcher = async (url, options = {}) => {
    const origin = new URL(url).origin
    if (down.includes(origin)) return new Response('', { status: 503 })
    if (options.method === 'PUT') { blobs.set(`${origin}/${options.headers['X-SHA-256']}`, options.body); return new Response('') }
    return blobs.has(url) ? new Response(blobs.get(url)) : new Response('', { status: 404 })
  }
  return { blobs, fetcher }
}
