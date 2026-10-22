import { useEffect, useRef, useState } from 'react'
import QrScanner from 'qr-scanner'
import { parseUpi } from '../upi.js'

// Camera view that resolves once it sees a UPI QR.
export default function Scanner({ onResult }) {
  const video = useRef(null)
  const [error, setError] = useState('')
  const [manual, setManual] = useState('')
  const [camera, setCamera] = useState('starting')
  const [cameraRequested, setCameraRequested] = useState(false)

  useEffect(() => {
    if (!cameraRequested) return
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
    scanner.start()
      .then(() => { if (!done) setCamera('ready') })
      .catch(() => {
        if (!done) {
          setCamera('unavailable')
          setError('Camera unavailable. Enter a UPI ID below to keep going.')
        }
      })
    return () => {
      done = true
      scanner.destroy()
    }
  }, [onResult, cameraRequested])

  const submitManual = (e) => {
    e.preventDefault()
    const v = manual.trim()
    const upi = parseUpi(v.startsWith('upi://') ? v : `upi://pay?pa=${encodeURIComponent(v)}`)
    if (upi) onResult(upi)
    else setError('Enter a UPI ID like name@okaxis')
  }

  return (
    <div className="scanner">
      {!cameraRequested && <div className="card"><p>Scan a QR, choose a saved image, or enter a UPI ID below.</p><button className="btn primary" onClick={() => setCameraRequested(true)}>Scan with camera</button><p className="dim">Camera permission is requested only when you choose to scan.</p></div>}
      {cameraRequested && <div className={`viewfinder ${camera === 'unavailable' ? 'camera-off' : ''}`}>
        <video ref={video} muted playsInline />
        {camera !== 'unavailable' && <div className="frame" />}
        {camera !== 'ready' && (
          <div className="camera-fallback" role="status">
            <span className="camera-fallback-mark">₹</span>
            <span>{camera === 'unavailable' ? 'Continue without scanning' : 'Starting camera…'}</span>
          </div>
        )}
      </div>}
      {cameraRequested && <button className="btn ghost" onClick={() => { setCameraRequested(false); setCamera('starting'); setError('') }}>Stop camera</button>}
      {error && <p className="hint warn" role="status">{error}</p>}
      <label className="field">Choose a QR image
        <input type="file" accept="image/*" onChange={async e => {
          const file = e.target.files?.[0]
          if (!file) return
          try {
            if (file.size > 10_000_000) throw new Error('Choose an image smaller than 10 MB.')
            const result = await QrScanner.scanImage(file, { returnDetailedScanResult: true })
            const upi = parseUpi(result.data)
            if (!upi) throw new Error('That image does not contain a supported UPI payment QR.')
            onResult(upi)
          } catch (error) { setError(error.message || 'Could not read that QR image.') }
        }} />
      </label>
      <form className="manual" onSubmit={submitManual}>
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="name@okaxis"
          aria-label="UPI ID"
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
