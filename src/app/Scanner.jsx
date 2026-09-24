import { useEffect, useRef, useState } from 'react'
import QrScanner from 'qr-scanner'
import { parseUpi } from '../upi.js'

// Camera view that resolves once it sees a UPI QR.
export default function Scanner({ onResult }) {
  const video = useRef(null)
  const [error, setError] = useState('')
  const [manual, setManual] = useState('')

  useEffect(() => {
    let done = false
    const scanner = new QrScanner(
      video.current,
      ({ data }) => {
        const upi = parseUpi(data)
        if (upi && !done) {
          done = true
          navigator.vibrate?.(30)
          scanner.stop()
          onResult(upi)
        } else if (!upi) {
          setError('That QR isn’t a UPI payment code')
        }
      },
      { preferredCamera: 'environment', highlightScanRegion: true, returnDetailedScanResult: true },
    )
    scanner.start().catch(() => setError('No camera here. Type the UPI ID instead.'))
    return () => {
      done = true
      scanner.destroy()
    }
  }, [onResult])

  const submitManual = (e) => {
    e.preventDefault()
    const v = manual.trim()
    const upi = parseUpi(v.startsWith('upi://') ? v : `upi://pay?pa=${encodeURIComponent(v)}`)
    if (upi) onResult(upi)
    else setError('Enter a UPI ID like name@okaxis')
  }

  return (
    <div className="scanner">
      <div className="viewfinder">
        <video ref={video} muted playsInline />
        <div className="frame" />
      </div>
      {error && <p className="hint warn">{error}</p>}
      <form className="manual" onSubmit={submitManual}>
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="or type a UPI ID"
          autoCapitalize="none"
          autoCorrect="off"
        />
        <button className="btn small" type="submit">
          Use
        </button>
      </form>
    </div>
  )
}
