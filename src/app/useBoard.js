import { useEffect, useMemo, useRef, useState } from 'react'
import { createRelayClient } from '../relays.js'
import { parse } from '../events.js'
import { createRanker, loadTrustData } from '../wot.js'

const DAY = 24 * 3600

// Live view of the board: every app event from the last day, the viewer's
// trust data, and profile names.
export function useBoard(trustRoot, me) {
  const client = useMemo(() => createRelayClient(), [])
  const [events, setEvents] = useState(() => new Map())
  const [trust, setTrust] = useState({ followLists: [], stamps: [], loading: true })
  const [names, setNames] = useState({})
  const asked = useRef(new Set())

  useEffect(() => {
    const since = Math.floor(Date.now() / 1000) - DAY
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
  }, [client, trustRoot])

  // Fetch kind-0 names for authors we haven't looked up yet.
  useEffect(() => {
    const want = [...new Set([...events.values()].map((e) => e.pubkey))].filter((pk) => !asked.current.has(pk))
    if (!want.length) return
    want.forEach((pk) => asked.current.add(pk))
    client.query({ kinds: [0], authors: want }).then((list) => {
      const out = {}
      for (const ev of list) {
        try {
          const m = JSON.parse(ev.content)
          out[ev.pubkey] = m.display_name || m.name
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
        stamps: [...trust.stamps, ...all.filter((e) => e.type === 'settled' || e.type === 'disputed')],
      }),
    [trustRoot, me, trust, all],
  )

  // Show an event locally right away, then send it.
  async function publish(signed) {
    const p = parse(signed)
    if (p) setEvents((prev) => new Map(prev).set(p.id, p))
    return client.publish(signed)
  }

  return { client, events: all, ranker, names, publish, trustLoading: trust.loading }
}
