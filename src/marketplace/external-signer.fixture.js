// Stand-in for an extension or bunker in tests; never used by the app.
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import { withMarketplace } from './remote-signer.js'

// Signs and does NIP-44 like an extension, never exposing sk to the app.
export function externalSigner(sk = generateSecretKey(), storage = new Map()) {
  const pubkey = getPublicKey(sk)
  const crypto44 = { encrypt: async (pk, text) => nip44.encrypt(text, nip44.getConversationKey(sk, pk)), decrypt: async (pk, text) => nip44.decrypt(text, nip44.getConversationKey(sk, pk)) }
  const store = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) }
  return { sk, storage, crypto44, signer: withMarketplace({ kind: 'extension', pubkey, sign: async t => finalizeEvent(t, sk) }, crypto44, store) }
}
