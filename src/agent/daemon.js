// The wot-pay agent: watches the board for its owner and does the legwork.
// Usage: OWNER=npub1... LN_ADDRESS=you@wallet.com npm run agent
//
// It claims offers from people the owner follows, DMs the owner (NIP-17) to
// pay by UPI, and stamps the trade once the owner confirms. Sats go to the
// owner's own address. The agent holds no sats and never opens a UPI app.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import { wrapEvent, unwrapEvent } from 'nostr-tools/nip17'
import * as nip19 from 'nostr-tools/nip19'
import { createRelayClient } from '../relays.js'
import { parse } from '../events.js'
import { createRanker, loadTrustData } from '../wot.js'
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
const brain = createBrain({ me, owner, lnAddress, policy, label })
const events = new Map()
let trust = { followLists: [], stamps: [] }

async function run(actions) {
  for (const a of actions) {
    try {
      if (a.type === 'dm') {
        await client.sendWrapped([wrapEvent(sk, { publicKey: owner }, a.text)])
        log('dm ->', a.text.split('\n')[0])
      } else {
        const signed = finalizeEvent(a.template, sk)
        const p = parse(signed)
        if (p) events.set(p.id, p)
        await client.publish(signed)
        log(a.type, signed.id.slice(0, 8))
      }
    } catch (e) {
      log('failed', a.type, e.message)
    }
  }
}

let timer
function think() {
  clearTimeout(timer)
  timer = setTimeout(() => {
    const all = [...events.values()]
    const stamps = [...trust.stamps, ...all.filter((e) => e.type === 'settled' || e.type === 'disputed')]
    const ranker = createRanker({ viewer: owner, followLists: trust.followLists, stamps })
    run(brain.onBoard({ events: all, ranker }))
  }, 800)
}

async function refreshTrust() {
  trust = await loadTrustData((f) => client.query(f), owner, { depth: 1 })
  const follows = trust.followLists.find((e) => e.pubkey === owner)?.tags.filter((t) => t[0] === 'p').length || 0
  log(`owner follows ${follows} keys`)
  for (const ev of await client.query({ kinds: [0], authors: [...new Set(trust.followLists.flatMap((e) => e.tags.filter((t) => t[0] === 'p').map((t) => t[1])))].slice(0, 500) })) {
    try {
      const m = JSON.parse(ev.content)
      names[ev.pubkey] = m.display_name || m.name || names[ev.pubkey]
    } catch {}
  }
  think()
}

const started = Math.floor(Date.now() / 1000)
const heard = new Set()

log(`agent ${nip19.npubEncode(me)}`)
log(`owner ${nip19.npubEncode(owner)}, max ₹${policy.maxInr}, sats to ${lnAddress}`)

await client.publish(
  finalizeEvent(
    {
      kind: 0,
      created_at: started,
      tags: [],
      content: JSON.stringify({ name: 'wot-pay agent', about: `Claims offers for ${nip19.npubEncode(owner)}. Never holds sats.` }),
    },
    sk,
  ),
).catch(() => {})

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

await run([{ type: 'dm', text: `Agent on. I’ll claim offers up to ₹${policy.maxInr} from people you follow and ask you to pay by UPI. Sats go to ${lnAddress}. Reply "status", "pause" or "resume".` }])
