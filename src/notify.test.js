import { expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { unwrapEvent } from 'nostr-tools/nip17'
import { offer, claim, acceptClaim, settled, disputed, cancelClaim, parse } from './events.js'
import { wrapNotice } from './marketplace/private.js'
import { createNotifier, noticesOn, setNotices } from './notify.js'

const person = () => { const sk = generateSecretKey(); return { sk, pubkey: getPublicKey(sk), wrapNotice: (to, text) => wrapNotice(sk, to, text) } }
const where = { origin: 'https://wot-pay.test', pathname: '/' }
const memory = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) } }
const until = async (check, what) => { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)) } throw new Error(`Timed out waiting for ${what}`) }

// A relay set that records where each wrap went and who has a private inbox.
function relays({ inboxes = {}, failFirst = false } = {}) {
  const log = { inbox: [], app: [] }
  let fail = failFirst
  return {
    log,
    sendWrapped: async wraps => { if (fail) { fail = false; throw new Error('no relay accepted the message') } log.app.push(...wraps) },
    publishTo: async (urls, wrap) => { log.inbox.push({ urls, wrap }) },
    queryIdentity: async filter => (inboxes[filter.authors[0]] ? [finalizeEvent({ kind: 10050, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['relay', inboxes[filter.authors[0]]]] }, inboxes.sks[filter.authors[0]])] : []),
  }
}
const open = (wrap, who) => unwrapEvent(wrap, who.sk)
const signed = (who, template) => parse(finalizeEvent(template, who.sk))
function trade() {
  const maker = person(), payer = person()
  const post = signed(maker, offer({ vpa: 'merchant@upi', payee: 'Corner Shop', inr: 500, sats: 1234 }))
  const taken = signed(payer, claim({ offerId: post.id, maker: maker.pubkey, receive: { method: 'lightning', address: 'payer@wallet.example' } }))
  return { maker, payer, post, taken }
}

it('tells each person about a public-offer step through their Nostr app, without payment details', async () => {
  const { maker, payer, post, taken } = trade(), net = relays()
  const makerSide = createNotifier({ client: net, signer: maker, where }), payerSide = createNotifier({ client: net, signer: payer, where })
  payerSide.forEvent(taken)
  await until(() => net.log.app.length === 1, 'claim notice')
  const first = open(net.log.app[0], maker)
  expect([first.kind, first.pubkey, first.tags.some(t => t[0] === 'subject')]).toEqual([14, payer.pubkey, false])
  expect(first.content).toBe(`wot-pay: Someone claimed your offer. Open it to review the claim. https://wot-pay.test/#offer/${post.id}`)

  const accepted = signed(maker, acceptClaim({ offerId: post.id, claimId: taken.id, counterparty: payer.pubkey }))
  const made = signed(payer, settled({ offerId: post.id, claimId: taken.id, counterparty: maker.pubkey }))
  const complaint = signed(maker, disputed({ offerId: post.id, claimId: taken.id, counterparty: payer.pubkey, reason: 'no sats' }))
  const cancel = signed(payer, cancelClaim({ offerId: post.id, claimId: taken.id }))
  makerSide.forEvent(accepted); payerSide.forEvent(made); makerSide.forEvent(complaint); payerSide.forEvent(cancel, id => id === post.id ? post : undefined)
  payerSide.tokenSent(maker.pubkey, post.id)
  await until(() => net.log.app.length === 6, 'all notices')
  const texts = net.log.app.map(w => { for (const who of [maker, payer]) try { return open(w, who).content } catch { /* Not addressed to this person. */ } })
  expect(texts.slice(1).join('\n')).toMatch(/claim was accepted[\s\S]*marked the trade settled[\s\S]*reported a problem[\s\S]*claim on your offer was cancelled[\s\S]*Sats were sent/)
  expect(texts.join('\n')).not.toMatch(/merchant@upi|Corner Shop|500|1234|payer@wallet/)
})

it('uses a private inbox when the recipient has one, and the app relays otherwise', async () => {
  const { maker, payer, taken } = trade(), sks = { [maker.pubkey]: maker.sk }
  const withInbox = relays({ inboxes: { [maker.pubkey]: 'wss://inbox.example', sks } })
  createNotifier({ client: withInbox, signer: payer, where }).forEvent(taken)
  await until(() => withInbox.log.inbox.length === 1, 'inbox delivery')
  expect([withInbox.log.inbox[0].urls, withInbox.log.app.length]).toEqual([['wss://inbox.example'], 0])
  const without = relays({ inboxes: { sks } })
  createNotifier({ client: without, signer: payer, where }).forEvent(taken)
  await until(() => without.log.app.length === 1, 'app-relay delivery')
  expect(without.log.inbox.length).toBe(0)
})

it('ignores other people\'s events, repeats, and the off switch; a failed send can be tried again', async () => {
  const { maker, payer, taken } = trade(), net = relays(), storage = memory()
  const other = createNotifier({ client: net, signer: maker, storage, where })
  other.forEvent(taken)
  await new Promise(r => setTimeout(r, 30))
  expect(net.log.app.length).toBe(0)
  const mine = createNotifier({ client: net, signer: payer, storage, where })
  mine.forEvent(taken); mine.forEvent(taken)
  await until(() => net.log.app.length === 1, 'single notice')
  await new Promise(r => setTimeout(r, 30))
  expect(net.log.app.length).toBe(1)
  expect(noticesOn(storage)).toBe(true)
  setNotices(false, storage)
  expect(noticesOn(storage)).toBe(false)
  createNotifier({ client: net, signer: payer, storage, where }).notify(maker.pubkey, 'x', { key: 'k' })
  await new Promise(r => setTimeout(r, 30))
  expect(net.log.app.length).toBe(1)
  setNotices(true, storage)
  const flaky = relays({ failFirst: true }), again = createNotifier({ client: flaky, signer: payer, storage, where })
  again.forEvent(taken)
  await new Promise(r => setTimeout(r, 30))
  expect(flaky.log.app.length).toBe(0)
  again.forEvent(taken)
  await until(() => flaky.log.app.length === 1, 'retry after failure')
})

it('does nothing, and never throws, without a signer, a notice-capable signer or a valid recipient', () => {
  const { taken, payer } = trade()
  expect(() => createNotifier({ client: relays(), signer: null, where }).forEvent(taken)).not.toThrow()
  expect(() => createNotifier({ client: relays(), signer: { pubkey: payer.pubkey }, where }).forEvent(taken)).not.toThrow()
  expect(() => createNotifier({ client: relays(), signer: payer, where }).notify('not-a-key', 'x')).not.toThrow()
})
