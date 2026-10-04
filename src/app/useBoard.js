import { useEffect, useMemo, useRef, useState } from 'react'
import { createRelayClient } from '../relays.js'
import { parse } from '../events.js'
import { createRanker, loadTrustData } from '../wot.js'

const DAY = 24 * 3600

// Live view of the board: every app event from the last day, the viewer's
// trust data, and profile names.
export function useBoard(trustRoot, me, revision = 0) {
  const client = useMemo(() => createRelayClient(), [])
  const [events, setEvents] = useState(() => new Map())
  const [trust, setTrust] = useState({ followLists: [], stamps: [], loading: true })
  const [names, setNames] = useState({})
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
    loadTrustData((f) => client.query(f), trustRoot).then((d) => live && setTrust({ ...d, loading: false }))
    return () => {
      live = false
    }
  }, [client, trustRoot, revision])

  // Fetch kind-0 names for authors we haven't looked up yet.
  useEffect(() => {
    const want = [...new Set([...events.values()].map((e) => e.pubkey))].filter(
      (pk) => !asked.current.has(pk),
    )
    if (!want.length) return
    want.forEach((pk) => asked.current.add(pk))
    client.query({ kinds: [0], authors: want }).then((list) => {
      const out = {}
      for (const ev of list) {
        try {
          const m = JSON.parse(ev.content)
          const name = m.display_name || m.name
          if (typeof name === 'string' && name.length <= 256) out[ev.pubkey] = name
        } catch {}
      }
      setNames((n) => ({ ...n, ...out }))
    })
  }, [client, events])

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

  // Relay reachability, so an empty board never hides a dead connection.
  const [relaysUp, setRelaysUp] = useState(null)
  useEffect(() => {
    const tick = () => setRelaysUp(navigator.onLine === false ? 0 : client.connected())
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
    events: all,
    ranker,
    names,
    publish,
    relaysUp,
    total: client.relays.length,
    trustLoading: trust.loading,
  }
}
