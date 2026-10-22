import { expect, it } from 'vitest'
import { getPubKeyFromPrivKey } from '@cashu/cashu-ts'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import { childSecret, childPubkeys, pickArbitratorKey, findChildSecret } from './arbitrator-keys.js'
import { marketplaceConfig, assertDeploymentAgreement } from './config.js'
import { testTrade } from './fixtures.js'

const seed = '7'.repeat(64), other = '8'.repeat(64)
it('derives independent per-trade keys from an offline seed and finds the one a case needs', async () => {
  const keys = await childPubkeys(seed, 8)
  expect(new Set(keys).size).toBe(8)
  expect(await childSecret(seed, 3)).toBe(await childSecret(seed, 3))
  expect(bytesToHex(getPubKeyFromPrivKey(hexToBytes(await childSecret(seed, 5))))).toBe(keys[5])
  expect(await findChildSecret(seed, keys[6])).toEqual({ index: 6, secret: await childSecret(seed, 6) })
  await expect(findChildSecret(other, keys[6], 16)).rejects.toThrow('did not produce')
  expect(await childPubkeys(other, 8)).not.toContain(keys[0])
})
it('picks the trade key from the agreement nonce so both sides can check it', async () => {
  const keys = await childPubkeys(seed, 8)
  expect(pickArbitratorKey(keys, 'a'.repeat(64))).toBe(pickArbitratorKey(keys, 'a'.repeat(64)))
  expect(new Set(['1','2','3','4','5','6','7','8','9'].map(c => pickArbitratorKey(keys, c.repeat(64)))).size).toBeGreaterThan(1)
  expect(() => pickArbitratorKey([], 'a'.repeat(64))).toThrow()
})
it('accepts agreements only with a key from the configured panel list', async () => {
  const { agreement: a } = await testTrade()
  const keys = [...await childPubkeys(seed, 3), a.escrowKeys.arbitrator]
  const config = marketplaceConfig({ VITE_ARBITRATOR_PANEL: JSON.stringify([{ name: 'Panel', pubkey: a.arbitrator, escrowKeys: keys }]) })
  expect(() => assertDeploymentAgreement(config, a)).not.toThrow()
  expect(() => assertDeploymentAgreement(config, { ...a, escrowKeys: { ...a.escrowKeys, arbitrator: a.escrowKeys.payer } })).toThrow('configured')
  for (const bad of [[], ['zz'], [keys[0], keys[0]]]) expect(marketplaceConfig({ VITE_ARBITRATOR_PANEL: JSON.stringify([{ name: 'P', pubkey: a.arbitrator, escrowKeys: bad }]) }).ready).toBe(false)
})
