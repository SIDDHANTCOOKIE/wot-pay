// The wot-pay agent: watches the board for its owner and does the legwork.
// Usage: OWNER=npub1... LN_ADDRESS=you@wallet.com npm run agent
//
// It claims offers from people the owner follows, DMs the owner (NIP-17) to
// pay by UPI, and stamps the trade once the owner confirms. Sats go to the
// owner's own address. The agent holds no sats and never opens a UPI app.
import './websocket.js'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import { wrapEvent, unwrapEvent } from 'nostr-tools/nip17'
import * as nip19 from 'nostr-tools/nip19'
import { createRelayClient } from '../relays.js'
import { mayDeliverMessage } from './payment-guard.js'
import { parse } from '../events.js'
import { createRanker, loadTrustData } from '../wot.js'
import { createOutbox } from './outbox.js'
import { createBrain, DEFAULT_POLICY } from './brain.js'

const env = process.env
const KEY_FILE = env.AGENT_KEY_FILE || '.agent-key'
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

function ownerHex(s) {
  try {
    const d = nip19.decode((s || '').trim())
    if (d.type === 'npub') return d.data
  } catch {}
  return /^[0-9a-f]{64}$/.test(s || '') ? s : null
}

const owner = ownerHex(env.OWNER)
const lnAddress = env.LN_ADDRESS
if (!owner || !lnAddress?.includes('@')) {
  console.error('Set OWNER (your npub) and LN_ADDRESS (where your sats should go).')
  process.exit(1)
}

// The agent has its own key, separate from the owner's.
if (!existsSync(KEY_FILE)) writeFileSync(KEY_FILE, bytesToHex(generateSecretKey()), { mode: 0o600 })
const sk = hexToBytes(readFileSync(KEY_FILE, 'utf8').trim())
const me = getPublicKey(sk)

const policy = {
  ...DEFAULT_POLICY,
  maxInr: Number(env.MAX_INR) || DEFAULT_POLICY.maxInr,
  minSatsPerInr: Number(env.MIN_SATS_PER_INR) || DEFAULT_POLICY.minSatsPerInr,
}

const client = createRelayClient()
const names = {}
const label = (pk) => names[pk] || nip19.npubEncode(pk).slice(0, 12) + '…'
const STATE_FILE = env.AGENT_STATE_FILE || '.agent-state.json'
let saved = null
if (existsSync(STATE_FILE)) {
  saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  if (saved.owner !== owner || saved.me !== me)
    throw new Error('Agent state belongs to another owner/key; choose a separate state file')
}
const brain = createBrain({ me, owner, lnAddress, policy, label, saved: saved?.brain })
const events = new Map()
if (brain.state.active) {
  events.set(brain.state.active.offer.id, brain.state.active.offer)
  if (brain.state.active.claim) events.set(brain.state.active.claim.id, brain.state.active.claim)
}
let trust = { followLists: [], stamps: [] }

function persist(queue) {
  const tmp = STATE_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify({ owner, me, brain: brain.snapshot(), queue }), { mode: 0o600 })
  renameSync(tmp, STATE_FILE)
}
const outbox = createOutbox({
  saved: saved?.queue || [],
  persist,
  completed: () => brain.completed(),
  snapshot: () => structuredClone(brain.snapshot()),
  restore: (before) => brain.restore(before),
  deliver: async (item) => {
    if (item.wraps) {
      if (!(await mayDeliverMessage(item, { events, query: filter => client.query(filter), me }))) return
      await client.sendWrapped(item.wraps)
    }
    else {
      await client.publish(item.signed)
      const p = parse(item.signed)
      if (p) events.set(p.id, p)
      if (p?.type === 'claim' && p.pubkey === me && brain.state.active?.offer.id === p.offerId) {
        brain.state.active.claimId = p.id
        brain.state.active.claim = p
      }
    }
  },
})
function run(actions) {
  const items = actions.map((a) =>
    a.type === 'dm'
      ? { wraps: [wrapEvent(sk, { publicKey: owner }, a.text)], messageScope: 'current', offerId: a.offerId, claimId: a.claimId, requiresAcceptance: !!a.requiresAcceptance }
      : { signed: finalizeEvent(a.template, sk), completeTrade: !!a.completeTrade },
  )
  return outbox.add(items)
}
setInterval(() => outbox.flush(), 15000)
await outbox.flush()

let timer
function think() {
  clearTimeout(timer)
  timer = setTimeout(() => {
    const all = [...events.values()]
    const stamps = [...trust.stamps, ...all.filter((e) => e.type === 'settled' || e.type === 'disputed')]
    const ranker = createRanker({
      viewer: owner,
      followLists: trust.followLists,
      stamps,
      events: [...(trust.trades || []), ...all],
    })
    run(brain.onBoard({ events: all, ranker }))
  }, 800)
}

async function refreshTrust() {
  trust = await loadTrustData((f) => client.query(f), owner, { depth: 1 })
  const follows =
    trust.followLists.find((e) => e.pubkey === owner)?.tags.filter((t) => t[0] === 'p').length || 0
  log(`owner follows ${follows} keys`)
  for (const ev of await client.query({
    kinds: [0],
    authors: [
      ...new Set(trust.followLists.flatMap((e) => e.tags.filter((t) => t[0] === 'p').map((t) => t[1]))),
    ].slice(0, 500),
  })) {
    try {
      const m = JSON.parse(ev.content)
      const name = m.display_name || m.name
      if (typeof name === 'string' && name.length <= 256) names[ev.pubkey] = name
    } catch {}
  }
  think()
}

const started = Math.floor(Date.now() / 1000)
const heard = new Set()

log(`agent ${nip19.npubEncode(me)}`)
log(`owner ${nip19.npubEncode(owner)}, max ₹${policy.maxInr}, sats to ${lnAddress}`)

await client
  .publish(
    finalizeEvent(
      {
        kind: 0,
        created_at: started,
        tags: [],
        content: JSON.stringify({
          name: 'wot-pay agent',
          about: `Claims offers for ${nip19.npubEncode(owner)}. Never holds sats.`,
        }),
      },
      sk,
    ),
  )
  .catch(() => {})

await refreshTrust()
setInterval(refreshTrust, 10 * 60 * 1000)

client.subscribe({ since: started - 3600 }, (ev) => {
  const p = parse(ev)
  if (!p || events.has(p.id)) return
  events.set(p.id, p)
  think()
})

// Only the owner can talk to the agent. Old messages are ignored.
client.subscribeWrapped(me, (w) => {
  let r
  try {
    r = unwrapEvent(w, sk)
  } catch {
    return
  }
  if (r.kind !== 14 || r.pubkey !== owner || r.created_at < started || heard.has(r.id)) return
  heard.add(r.id)
  log('owner:', r.content.slice(0, 60))
  run(brain.onOwnerMessage(r.content))
  think()
})

await run([
  {
    type: 'dm',
    text: `Agent on. I’ll claim offers up to ₹${policy.maxInr} from people you follow and ask you to pay by UPI. Sats go to ${lnAddress}. Reply "status", "pause" or "resume".`,
  },
])
