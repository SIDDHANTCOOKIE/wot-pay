import { encryptBackup, decryptBackup, newRecoverySecret } from '../recovery.js'
import { wrapPrivateWith, openPrivateWith, wrapNoticeWith } from './private.js'

// Lets an external signer (NIP-07 extension or NIP-46 bunker) trade. Private
// records are sealed with a random vault key that is stored only encrypted to
// the user's own key (NIP-44), so one decryption per session unlocks it. The
// key never leaves this browser except inside the recovery kit. Without NIP-44
// support the signer stays browse-only.
export function withMarketplace(signer, nip44, storage = globalThis.localStorage) {
  if (!signer || !nip44) return signer
  const slot = `wot-pay:vault-key:${signer.pubkey}`
  let key = null
  const check = hex => { if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('This browser\'s private trade key could not be unlocked.'); return hex }
  const vaultKey = () => key ||= (async () => {
    const stored = storage.getItem(slot)
    // A key is only created when none exists, never over one that failed to
    // decrypt: records sealed with the old key would become unreadable.
    if (stored) return check(await nip44.decrypt(signer.pubkey, stored))
    const hex = newRecoverySecret()
    storage.setItem(slot, await nip44.encrypt(signer.pubkey, hex))
    return hex
  })().catch(e => { key = null; throw e })
  return {
    ...signer,
    vaultKey,
    // From a recovery kit: replaces this browser's key so restored records open.
    importVaultKey: async hex => { check(hex); storage.setItem(slot, await nip44.encrypt(signer.pubkey, hex)); key = Promise.resolve(hex) },
    sealLocal: async value => new TextDecoder().decode(await encryptBackup(value, await vaultKey())),
    openLocal: async text => {
      try { return await decryptBackup(new TextEncoder().encode(text), await vaultKey()) }
      catch (e) { throw new Error(`Private records here were sealed with a different key. Restore your recovery kit. (${e.message})`) }
    },
    wrapPrivate: (to, signed) => wrapPrivateWith(signer, nip44, to, signed),
    openPrivate: wrap => openPrivateWith(nip44, wrap),
    wrapNotice: (to, text) => wrapNoticeWith(signer, nip44, to, text),
  }
}
