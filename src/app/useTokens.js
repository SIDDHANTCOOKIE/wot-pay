import { useEffect, useState } from 'react'

// Cashu tokens sent to us (or by us) over NIP-17, matched to offers by id.
export function useTokens(client, signer) {
  const [tokens, setTokens] = useState([])
  const supported = !!signer.wrapToken

  const add = (t) => setTokens((prev) => (prev.some((x) => x.id === t.id) ? prev : [...prev, t]))

  useEffect(() => {
    setTokens([])
    if (!supported) return
    return client.subscribeWrapped(signer.pubkey, (w) => {
      const t = signer.openToken(w)
      if (t) add(t)
    })
  }, [client, signer, supported])

  async function send(to, token, offerId) {
    const wraps = signer.wrapToken(to, token, offerId)
    await client.sendWrapped(wraps)
    const own = signer.openToken(wraps[1])
    if (own) add(own)
  }

  const forOffer = (offerId, from) => tokens.filter((t) => t.offerId === offerId && t.from === from)

  return { supported, send, forOffer }
}
