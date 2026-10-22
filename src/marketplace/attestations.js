import { verifyEvent } from 'nostr-tools/pure'

// Public, opt-in record that a protected trade completed. Each party may
// publish one; a completion counts only when both did, for the same
// commitment. It reveals the counterparty, an amount range and the week, but
// never the merchant, UPI ID, exact amount or agreement.
export const COMPLETION_KIND = 3408
export const COMPLETION_TAG = 'wot-pay-completion-v1'
const WEEK = 7 * 86400
const RANGES = [[50000, 'under-500'], [200000, '500-2000'], [1000000, '2000-10000'], [Infinity, 'over-10000']]
const HEX = /^[0-9a-f]{64}$/

export const amountRange = paise => RANGES.find(([limit]) => paise < limit)[1]

// Both parties derive the same commitment from the private agreement id, which
// nobody else can compute because the agreement includes a random nonce.
export async function completionCommitment(agreementId) {
  const bytes = new TextEncoder().encode(`wot-pay:completion:v1:${agreementId}`)
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function completionTemplate(agreement, agreementId, me, completedAt, now = Math.floor(Date.now() / 1000)) {
  if (![agreement.requester, agreement.payer].includes(me)) throw new Error('Only trade participants can attest a completion.')
  const counterparty = me === agreement.requester ? agreement.payer : agreement.requester
  return { kind: COMPLETION_KIND, created_at: now, content: '', tags: [['t', COMPLETION_TAG], ['p', counterparty], ['c', await completionCommitment(agreementId)], ['amount', amountRange(agreement.paise)], ['week', String(Math.floor(completedAt / WEEK))]] }
}

export function parseCompletion(raw) {
  try {
    const e = JSON.parse(JSON.stringify(raw))
    if (e.kind !== COMPLETION_KIND || e.content !== '' || e.tags.length !== 5 || !verifyEvent(e)) return null
    const tag = name => e.tags.find(t => t[0] === name && t.length === 2)?.[1]
    const [t, counterparty, commitment, amount, week] = ['t', 'p', 'c', 'amount', 'week'].map(tag)
    if (t !== COMPLETION_TAG || !HEX.test(counterparty) || counterparty === e.pubkey || !HEX.test(commitment) || !RANGES.some(([, name]) => name === amount) || !/^\d{1,6}$/.test(week || '')) return null
    return { id: e.id, pubkey: e.pubkey, counterparty, commitment, amount, week: Number(week), created_at: e.created_at }
  } catch { return null }
}

// Pairs of attestations that agree: each names the other as counterparty, for
// the same commitment and amount range, within a week of each other. Returns
// one entry per commitment, so repeats and replays count once.
export function mutualCompletions(events) {
  const parsed = events.map(e => e?.commitment ? e : parseCompletion(e)).filter(Boolean)
  const byCommitment = new Map()
  for (const a of parsed) byCommitment.set(a.commitment, [...(byCommitment.get(a.commitment) || []), a])
  const mutual = []
  for (const [commitment, list] of byCommitment) {
    const match = list.flatMap(a => list.filter(b => b.pubkey === a.counterparty && b.counterparty === a.pubkey && b.amount === a.amount && Math.abs(b.week - a.week) <= 1).map(b => [a, b]))[0]
    if (match) mutual.push({ commitment, parties: [match[0].pubkey, match[1].pubkey].sort(), amount: match[0].amount, week: Math.min(match[0].week, match[1].week) })
  }
  return mutual
}
