import { createHistory, verifiedPublicEvent } from '../history.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createRelayClient } from '../relays.js'
import { connectivity } from '../offline.js'
import { parse } from '../events.js'
import { createRanker, loadTrustData } from '../wot.js'
import { loadProfiles } from './profiles.js'

const DAY = 24 * 3600

// Live view of the board: every app event from the last day, the viewer's
// trust data, and profile names.
export function useBoard(trustRoot, me, revision = 0, { onPublished } = {}) {
  const history = useMemo(() => createHistory(), [])
  const [historyError, setHistoryError] = useState('')
  const [pending, setPending] = useState([])
  const client = useMemo(() => createRelayClient(), [])
  const [events, setEvents] = useState(() => new Map())
  const [trust, setTrust] = useState({ followLists: [], stamps: [], loading: true })
  const [profiles, setProfiles] = useState({})
  const [identityRevision, setIdentityRevision] = useState(0)
  revision += identityRevision
  const [profileRetry, setProfileRetry] = useState(0)
  const asked = useRef(new Set())

  const remember = (ev) => {
    const verified = verifiedPublicEvent(ev)
    if (!verified) return
    const p = parse(verified)
    setEvents(prev => prev.has(p.id) ? prev : new Map(prev).set(p.id, p))
    history.acknowledge(ev).then(() => setPending(prev => prev.filter(e => e.id !== ev.id))).catch(() => setHistoryError('Could not save trade history. Keep this browser open and check storage permissions.'))
  }
  useEffect(() => {
    let live = true
    history.load().then(raw => {
      if (!live) return
      setEvents(prev => new Map([...raw.map(e => [e.id, parse(e)]), ...prev]))
      const ids = raw.filter(e => parse(e)?.type === 'offer').map(e => e.id)
      for (let i = 0; i < ids.length; i += 100)
        client.query({ '#e': ids.slice(i, i + 100) }).then(list => { if (live) list.forEach(remember) }).catch(() => {})
    }).catch(() => setHistoryError('Local history is unavailable. Relay history may be incomplete.'))
    return () => { live = false }
  }, [history, client])
  useEffect(() => {
    let live = true
    setPending([])
    if (!me) return
    history.pending(me).then(list => { if (live) setPending(list) }).catch(() => {})
    // Recover this identity's older trades, beyond the one-day discovery board.
    Promise.all([client.query({ authors: [me], '#t': ['wot-pay'] }), client.query({ '#p': [me], '#t': ['wot-pay'] })]).then(async groups => {
      if (!live) return
      const raw = groups.flat()
      raw.forEach(remember)
      const ids = [...new Set(raw.map(parse).filter(Boolean).map(e => e.offerId || (e.type === 'offer' ? e.id : null)).filter(Boolean))]
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100)
        const groups = await Promise.all([client.query({ ids: chunk }), client.query({ '#e': chunk })])
        if (live) groups.flat().forEach(remember)
      }
    }).catch(() => {})
    return () => { live = false }
  }, [me, client, history])

  const boardSub = useRef(null)
  useEffect(() => {
    const linked = location.hash.match(/^#offer\/([0-9a-f]{64})$/)?.[1]
    if (linked)
      Promise.all([client.query({ ids: [linked] }), client.query({ '#e': [linked] })])
        .then((groups) => {
          const list = groups.flat()
          for (const ev of list) {
            remember(ev)
          }
        })
        .catch(() => {})
    const start = () => {
      boardSub.current?.()
      const since = Math.floor(Date.now() / 1000) - DAY
      boardSub.current = client.subscribe({ since }, (ev) => {
        remember(ev)
      })
    }
    start()
    return () => boardSub.current?.()
  }, [client])

  useEffect(() => {
    if (!trustRoot) { setTrust({ followLists: [], stamps: [], trades: [], loading: false }); return }
    let live = true
    setTrust((t) => ({ ...t, loading: true }))
    loadTrustData((f) => f.kinds?.includes(3) ? client.queryIdentity(f, { discover: f.authors?.length === 1 && f.authors[0] === trustRoot, refresh: revision > 0 }) : client.query(f), trustRoot).then((d) => live && setTrust({ ...d, loading: false }))
    return () => {
      live = false
    }
  }, [client, trustRoot, revision])

  useEffect(() => {
    if (!me) return
    const retry = () => { asked.current.delete(me); setProfileRetry(n => n + 1) }
    if (revision) retry()
    const timer = setTimeout(retry, 15000)
    window.addEventListener('online', retry)
    return () => { clearTimeout(timer); window.removeEventListener('online', retry) }
  }, [me, revision])
  // Fetch kind-0 profile metadata for authors we haven't looked up yet.
  useEffect(() => {
    const want = [...new Set([me, ...[...events.values()].map((e) => e.pubkey)].filter(Boolean))].filter(
      (pk) => !asked.current.has(pk),
    )
    if (!want.length) return
    want.forEach((pk) => asked.current.add(pk))
    let live = true
    loadProfiles(client, want, { owner: trustRoot || me }).then(out => {
      if (live) setProfiles(p => ({ ...p, ...out }))
    }).catch(() => {})
    return () => { live = false; want.forEach(pk => asked.current.delete(pk)) }
  }, [client, events, me, trustRoot, profileRetry, revision])

  const names = useMemo(() => Object.fromEntries(Object.entries(profiles).map(([pk, p]) => [pk, p.name])), [profiles])

  const all = useMemo(() => [...events.values()], [events])
  const ranker = useMemo(
    () =>
      createRanker({
        viewer: [trustRoot, me],
        followLists: trust.followLists,
        events: [...(trust.trades || []), ...all],
        stamps: [...trust.stamps, ...all.filter((e) => e.type === 'settled' || e.type === 'disputed')],
        completions: trust.completions || [],
      }),
    [trustRoot, me, trust, all],
  )

  useEffect(() => () => client.close(), [client])

  // Relay reachability, so an empty board never hides a dead connection.
  const [relayStates, setRelayStates] = useState(() => client.relayStatus())
  const [relaysUp, setRelaysUp] = useState(null)
  const downSince = useRef(null)
  useEffect(() => {
    const tick = () => {
      const c = connectivity({ connected: navigator.onLine === false ? 0 : client.connected(), online: navigator.onLine !== false, downSince: downSince.current })
      downSince.current = c.downSince
      setRelaysUp(c.relaysUp)
      setRelayStates(client.relayStatus())
      if (c.resubscribe) {
        boardSub.current?.()
        const since = Math.floor(Date.now() / 1000) - DAY
        boardSub.current = client.subscribe({ since }, (ev) => {
          remember(ev)
        })
        downSince.current = Date.now()
      }
    }
    const id = setInterval(tick, 3000)
    const first = setTimeout(tick, 1500)
    return () => {
      clearInterval(id)
      clearTimeout(first)
    }
  }, [client])

  // Persist the exact signed operation before sending. A lost acknowledgement
  // is uncertain delivery, never evidence that nothing was published.
  async function publish(signed) {
    const next = parse(signed)
    if (!next || signed.pubkey !== me) throw new Error('Signed event does not match the active identity.')
    const unsent = await history.pending(me)
    if (unsent.some(e => e.id !== signed.id && parse(e)?.offerId === next.offerId))
      throw new Error('A saved event for this trade still has unconfirmed delivery. Retry it from My trades first.')
    await history.save(signed, true)
    setPending(prev => [...prev.filter(e => e.id !== signed.id), signed])
    try {
      const result = await client.publish(signed)
      await history.acknowledge(signed)
      remember(signed)
      setPending(prev => prev.filter(e => e.id !== signed.id))
      // A notice must never turn a published event into an error.
      try { onPublished?.(next, id => events.get(id)) } catch { /* Best effort. */ }
      return result
    } catch (e) {
      throw e.name === 'TokenLeakError' ? e : new Error('Delivery unconfirmed. Retry the saved event from My trades; do not create another payment instruction.')
    }
  }

  return {
    client,
    historyError, pending, retryPending: publish,
    refreshIdentity: async () => { asked.current.delete(me); setIdentityRevision(n => n + 1) },
    events: all,
    ranker,
    names,
    profiles,
    publish,
    relaysUp,
    relayStates,
    total: client.relays.length,
    trustLoading: trust.loading,
  }
}
