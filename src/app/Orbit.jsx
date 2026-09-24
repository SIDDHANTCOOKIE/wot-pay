// The trust signature: you at the centre, rings for each hop, and the other
// person placed on the ring where they sit in your web.

const RINGS = [0.36, 0.64, 0.92] // 1 hop, 2 hops, 3 hops (fraction of radius)

export function tone(trust) {
  if (!trust) return 'far'
  if (trust.disputes > 0) return 'bad'
  if (trust.hops === 0 || trust.hops === 1) return 'good'
  if (trust.hops === null) return 'far'
  return 'ok'
}

export function where(trust) {
  const { hops } = trust
  if (hops === 0) return 'You'
  if (hops === 1) return 'You follow them'
  if (hops === null) return 'Outside your web'
  return `${hops} hops away`
}

// Stable angle per key, so the same person always sits in the same spot.
const angleOf = (pk = '') => (parseInt(pk.slice(0, 6) || '0', 16) % 360) * (Math.PI / 180)

export default function Orbit({ trust, pubkey, size = 96, live = true }) {
  const r = size / 2
  const t = tone(trust)
  const hops = trust?.hops
  const ring = hops === null || hops === undefined ? null : Math.min(Math.max(hops, 1), 3) - 1
  const dist = ring === null ? 1.08 : RINGS[ring]
  const a = angleOf(pubkey)
  const x = r + Math.cos(a) * dist * r * 0.92
  const y = r + Math.sin(a) * dist * r * 0.92
  const dot = Math.max(3, size / 22)

  return (
    <svg className={`orbit ${t} ${live ? 'live' : ''}`} width={size} height={size} viewBox={`-6 -6 ${size + 12} ${size + 12}`} aria-hidden="true">
      {RINGS.map((f, i) => (
        <circle key={i} className={`ring ${ring === i ? 'on' : ''}`} cx={r} cy={r} r={f * r * 0.92} />
      ))}
      {ring !== null && <line className="tether" x1={r} y1={r} x2={x} y2={y} />}
      <circle className="me" cx={r} cy={r} r={dot} />
      <g className="them-g" style={{ transformOrigin: `${x}px ${y}px` }}>
        <circle className="halo" cx={x} cy={y} r={dot * 2.4} />
        <circle className="them" cx={x} cy={y} r={dot} />
      </g>
    </svg>
  )
}

// The moment a trade closes: the tether draws, both ends light up.
export function SettleMark({ ok = true }) {
  return (
    <svg className={`settle-mark ${ok ? 'ok' : 'bad'}`} viewBox="0 0 160 64" aria-hidden="true">
      <line className="track" x1="24" y1="32" x2="136" y2="32" />
      <line className="draw" x1="24" y1="32" x2="136" y2="32" />
      <circle className="end a" cx="24" cy="32" r="7" />
      <circle className="end b" cx="136" cy="32" r="7" />
      <circle className="pulse" cx="136" cy="32" r="7" />
    </svg>
  )
}
