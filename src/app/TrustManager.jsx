import { useEffect, useState } from 'react'
import { toHexPubkey, npubShort } from './identity.js'
import { latestFollow, mergeFollows } from '../follows.js'
export default function TrustManager({ board, signer, onChanged }) {
  const [list, setList] = useState(null),
    [loaded, setLoaded] = useState(false),
    [value, setValue] = useState(''),
    [error, setError] = useState(''),
    [pending, setPending] = useState(null),
    [busy, setBusy] = useState(false)
  async function load() {
    setLoaded(false)
    setError('')
    try {
      if (board.client.connected() === 0) throw Error('No relay connected')
      setList(latestFollow(await board.client.query({ kinds: [3], authors: [signer.pubkey] }), signer.pubkey))
      setLoaded(true)
    } catch {
      setError('Could not verify your current follows. Reconnect and refresh before editing.')
    }
  }
  useEffect(() => {
    load()
  }, [signer.pubkey])
  async function confirm() {
    setBusy(true)
    setError('')
    try {
      if (board.client.connected() === 0) throw Error('No relay connected')
      const current = latestFollow(
        await board.client.query({ kinds: [3], authors: [signer.pubkey] }),
        signer.pubkey,
      )
      if ((current?.id || null) !== (list?.id || null)) {
        setList(current)
        setPending(null)
        throw Error('Your follows changed. Review the updated list and try again.')
      }
      const signed = await signer.sign(mergeFollows(current, signer.pubkey, pending.add, pending.remove))
      await board.publish(signed)
      setList(signed)
      setLoaded(true)
      setPending(null)
      setValue('')
      onChanged()
    } catch {
      setError('Follow update not confirmed. Refresh and review before trying again.')
    } finally {
      setBusy(false)
    }
  }
  const people = [
    ...new Set(
      (list?.tags || []).filter((t) => t[0] === 'p' && /^[0-9a-f]{64}$/.test(t[1])).map((t) => t[1]),
    ),
  ]
  return (
    <>
      <h2>People I follow / trust</h2>
      <p className="dim">
        Edits your signed Nostr follow list, not a private trust list. Only add people you actually trust for
        this trade. Existing follows and metadata are preserved.
      </p>
      <button className="btn ghost" disabled={busy} onClick={load}>
        Refresh follows
      </button>
      {loaded && !list && (
        <p className="hint warn">
          No follow list found on these relays. Confirm only if this identity has no existing follows
          elsewhere; omitted relay history cannot be ruled out.
        </p>
      )}
      {people.map((pk) => (
        <div className="row" key={pk}>
          <span className="mono">{npubShort(pk)}</span>
          <button
            className="btn small ghost"
            disabled={busy}
            onClick={() => setPending({ add: [], remove: [pk] })}
          >
            Remove
          </button>
        </div>
      ))}
      <input
        aria-label="Trusted person npub"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="npub1…"
      />
      <button
        className="btn ghost"
        disabled={!loaded || busy || !toHexPubkey(value)}
        onClick={() => setPending({ add: [toHexPubkey(value)], remove: [] })}
      >
        Review add
      </button>
      {pending && (
        <div className="card">
          <p>
            Publish {pending.add.length ? 'addition' : 'removal'} of{' '}
            {npubShort(pending.add[0] || pending.remove[0])} as a public kind-3 follow list from{' '}
            {npubShort(signer.pubkey)}? All other entries stay.
          </p>
          <button className="btn primary" disabled={busy} onClick={confirm}>
            Confirm and publish follows
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => setPending(null)}>
            Cancel
          </button>
        </div>
      )}
      {error && (
        <p className="hint warn" role="alert">
          {error}
        </p>
      )}
    </>
  )
}
