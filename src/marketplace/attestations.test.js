import { expect, it } from 'vitest'
import { finalizeEvent } from 'nostr-tools/pure'
import { testTrade } from './fixtures.js'
import { completionTemplate, parseCompletion, mutualCompletions, amountRange, completionCommitment } from './attestations.js'

async function attestations(at = 1800000000) {
  const t = await testTrade()
  const by = async (role, weekShift = 0, overrides = {}) => {
    const tpl = await completionTemplate({ ...t.agreement, ...overrides }, t.id, t.agreement[role], at + weekShift * 7 * 86400)
    return finalizeEvent(tpl, t.identities[role].sk)
  }
  return { ...t, by }
}
it('publishes only counterparty, amount range and week, and parses strictly', async () => {
  const t = await attestations()
  const event = await t.by('requester')
  expect(JSON.stringify(event)).not.toMatch(/example@upi|Test merchant|50000/)
  expect(parseCompletion(event)).toMatchObject({ counterparty: t.agreement.payer, amount: '500-2000', commitment: await completionCommitment(t.id) })
  for (const bad of [{ ...event, content: 'x' }, { ...event, tags: [...event.tags, ['x', '1']] }]) expect(parseCompletion(bad)).toBeNull()
  expect(parseCompletion(finalizeEvent({ ...event, tags: event.tags.map(x => x[0] === 'p' ? ['p', t.agreement.requester] : x) }, t.identities.requester.sk))).toBeNull()
  await expect(completionTemplate(t.agreement, t.id, t.agreement.arbitrator, 0)).rejects.toThrow()
  expect([amountRange(49999), amountRange(50000), amountRange(1000000)]).toEqual(['under-500', '500-2000', 'over-10000'])
})
it('counts a completion only when both parties attest matching terms, once per trade', async () => {
  const t = await attestations()
  const requester = await t.by('requester'), payer = await t.by('payer', 1)
  expect(mutualCompletions([requester])).toEqual([])
  expect(mutualCompletions([requester, payer, requester, payer])).toHaveLength(1)
  expect(mutualCompletions([requester, await t.by('payer', 2)])).toEqual([])
  expect(mutualCompletions([requester, await t.by('payer', 0, { paise: 5000000 })])).toEqual([])
})
