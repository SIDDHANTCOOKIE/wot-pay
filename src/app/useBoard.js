import { useEffect, useMemo, useRef, useState } from 'react'
import { createRelayClient } from '../relays.js'
import { parse } from '../events.js'
import { createRanker, loadTrustData } from '../wot.js'
import { readProfiles } from './profiles.js'

const DAY = 24 * 3600

// Live view of the board: every app event from the last day, the viewer's
// trust data, and profile names.
export function useBoard(trustRoot, me, revision = 0) {
  const client = useMemo(() => createRelayClient(), [])
  const [events, setEvents] = useState(() => new Map())
  const [trust, setTrust] = useState({ followLists: [], stamps: [], loading: true })
  const [profiles, setProfiles] = useState({})
  const [identityRevision, setIdentityRevision] = useState(0)
  revision += identityRevision
  const [profileRetry, setProfileRetry] = useState(0)
  const asked = useRef(new Set())

  useEffect(() => {
    const since = Math.floor(Date.now() / 1000) - DAY
    const linked = location.hash.match(/^#offer\/([0-9a-f]{64})$/)?.[1]
    if (linked)
      Promise.all([client.query({ ids: [linked] }), client.query({ '#e': [linked] })])
        .then((groups) => {
          const list = groups.flat()
          for (const ev of list) {
            const p = parse(ev)
            if (p) setEvents((prev) => new Map(prev).set(p.id, p))
          }
        })
        .catch(() => {})
    const stop = client.subscribe({ since }, (ev) => {
      const p = parse(ev)
      if (!p) return
      setEvents((prev) => (prev.has(p.id) ? prev : new Map(prev).set(p.id, p)))
    })
    return stop
  }, [client])

  useEffect(() => {
    if (!trustRoot) return
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
    const groupsToQuery = [want.filter(pk => pk !== me), want.filter(pk => pk === me)].filter(group => group.length)
    Promise.all(groupsToQuery.map(authors => client.queryIdentity({ kinds: [0], authors }, { discover: authors.length === 1 && authors[0] === me }))).then((groups) => {
      const list = groups.flat()
      const out = readProfiles(list, want)
      setProfiles((p) => ({ ...p, ...out }))
    }).catch(() => {})
  }, [client, events, me, profileRetry, revision])

  const names = useMemo(() => Object.fromEntries(Object.entries(profiles).map(([pk, p]) => [pk, p.name])), [profiles])

  const all = useMemo(() => [...events.values()], [events])
  const ranker = useMemo(
    () =>
      createRanker({
        viewer: [trustRoot, me],
        followLists: trust.followLists,
        events: [...(trust.trades || []), ...all],
        stamps: [...trust.stamps, ...all.filter((e) => e.type === 'settled' || e.type === 'disputed')],
      }),
    [trustRoot, me, trust, all],
  )

  useEffect(() => () => client.close(), [client])

  // Relay reachability, so an empty board never hides a dead connection.
  const [relayStates, setRelayStates] = useState(() => client.relayStatus())
  const [relaysUp, setRelaysUp] = useState(null)
  useEffect(() => {
    const tick = () => { setRelaysUp(navigator.onLine === false ? 0 : client.connected()); setRelayStates(client.relayStatus()) }
    const id = setInterval(tick, 3000)
    const first = setTimeout(tick, 1500)
    return () => {
      clearInterval(id)
      clearTimeout(first)
    }
  }, [client])

  // Show an event locally right away, then send it. If no relay takes it,
  // take it back off the screen so nothing looks sent that wasn't.
  async function publish(signed) {
    const p = parse(signed)
    if (p) setEvents((prev) => new Map(prev).set(p.id, p))
    try {
      return await client.publish(signed)
    } catch (e) {
      if (p)
        setEvents((prev) => {
          const next = new Map(prev)
          next.delete(p.id)
          return next
        })
      throw e.name === 'TokenLeakError' ? e : new Error('No relay accepted it. Nothing was sent, try again.')
    }
  }

  return {
    client,
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
