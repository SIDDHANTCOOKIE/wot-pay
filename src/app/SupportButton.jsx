import { useEffect, useId, useMemo, useRef, useState } from 'react'
import qrcode from 'qrcode-generator'
import { Copy, sats as satsLabel } from './ui.jsx'
import { useSupport, supportConfig, PRESETS, PROOF_TEXT, receiptText } from './useSupport.js'
import { shortHash } from '../support/lnurl.js'

// A small "Support us" button. Open it, pick an amount, get a Lightning invoice
// for exactly that amount and a receipt once it is paid. It never touches trade
// funds and stays hidden until a Lightning address is configured.
export default function SupportButton({ signer, client, config = supportConfig() }) {
  const support = useSupport({ ...config, signer, client })
  if (!config.address) return null
  return <>
    <button type="button" className="support-btn" onClick={support.open}>⚡ Support us</button>
    {support.state.step !== 'closed' && <SupportSheet support={support} config={config} signer={signer} />}
  </>
}

function Qr({ text }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, 'L')
    // Upper case keeps the code in the compact alphanumeric mode wallets read well.
    qr.addData(`LIGHTNING:${text.toUpperCase()}`, 'Alphanumeric')
    qr.make()
    const n = qr.getModuleCount(), parts = []
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) parts.push(`M${x + 4} ${y + 4}h1v1h-1z`)
    return { size: n + 8, path: parts.join('') }
  }, [text])
  return <svg className="support-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Lightning invoice QR code" shapeRendering="crispEdges">
    <rect width={size} height={size} fill="#fff" /><path d={path} fill="#000" />
  </svg>
}

function useCountdown(expiresAt, active) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [active])
  const left = Math.max(0, (expiresAt ?? 0) - now)
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

export function SupportSheet({ support, config, signer }) {
  const { state, close, create, confirmPaid, again, open } = support
  const sheet = useRef(null), titleId = useId()
  const [amount, setAmount] = useState('5000'), [comment, setComment] = useState(''), [publicZap, setPublicZap] = useState(false)
  useEffect(() => {
    const previous = document.activeElement, overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    sheet.current?.querySelector('button')?.focus()
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus() }
  }, [])
  // Escape works wherever focus is: each step replaces the button that was
  // clicked, which drops focus to the page behind the sheet.
  useEffect(() => {
    const onEscape = e => { if (e.key === 'Escape') { e.preventDefault(); close() } }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [close])
  function onKeyDown(e) {
    if (e.key !== 'Tab') return
    const controls = [...sheet.current.querySelectorAll('button, a[href], input')].filter(el => !el.disabled && el.getClientRects().length)
    const first = controls[0], last = controls.at(-1)
    if (!first) { e.preventDefault(); return }
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }
  const { step, pay, invoice, receipt, error } = state
  // When a step replaces the focused button, bring focus back into the dialog.
  useEffect(() => { if (sheet.current && !sheet.current.contains(document.activeElement)) sheet.current.focus() }, [step])
  const countdown = useCountdown(invoice?.expiresAt, step === 'invoice')
  const chosen = Number(amount)
  const zapOffered = !!pay?.allowsNostr && !!signer && !!config.recipient

  return <div className="sheet-bg" onMouseDown={e => { if (e.target === e.currentTarget) close() }}>
    <div className="sheet tall" ref={sheet} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown} tabIndex={-1}>
      <div className="row"><h2 id={titleId}>{step === 'paid' ? 'Thank you' : 'Support wot-pay'}</h2><button type="button" className="btn ghost small" onClick={close}>Close</button></div>

      {step === 'loading' && <p role="status" className="dim">Contacting the payment provider…</p>}

      {step === 'fallback' && <>
        <p className="hint warn" role="status">{error}</p>
        <p className="dim">Pay any amount to this Lightning address from your wallet:</p>
        <p className="mono">{config.address}</p>
        <div className="actions"><Copy text={config.address} label="Copy address" /><a className="btn ghost small" href={`lightning:${config.address}`}>Open in wallet</a><button type="button" className="btn ghost small" onClick={open}>Try again</button></div>
      </>}

      {(step === 'amount' || step === 'working') && pay && <>
        <p className="dim">wot-pay has no platform fee. Optional support helps keep it running. It never affects trades, ranking or settlement.</p>
        <div className="support-presets" role="group" aria-label="Amount in sats">
          {PRESETS.filter(n => n >= pay.minSats && n <= pay.maxSats).map(n => <button key={n} type="button" className={`btn ghost small${chosen === n ? ' on' : ''}`} aria-pressed={chosen === n} onClick={() => setAmount(String(n))}>{n.toLocaleString('en-US')}</button>)}
        </div>
        <label className="field"><span>Amount (sats)</span><input inputMode="numeric" value={amount} onChange={e => setAmount(e.target.value.replace(/\D/g, ''))} aria-describedby={`${titleId}-range`} /><small id={`${titleId}-range`} className="dim">Between {pay.minSats.toLocaleString('en-US')} and {pay.maxSats.toLocaleString('en-US')} sats</small></label>
        {pay.commentAllowed > 0 && <label className="field"><span>Note (optional)</span><input value={comment} maxLength={pay.commentAllowed} onChange={e => setComment(e.target.value)} /></label>}
        {zapOffered && <label className="field check"><span><input type="checkbox" checked={publicZap} onChange={e => setPublicZap(e.target.checked)} />Also zap publicly on Nostr</span><small className="dim">Appears on our Nostr profile and shows your key and note. Leave off to stay private.</small></label>}
        <p className="fine">Shared with {pay.domain}: the amount{comment.trim() && pay.commentAllowed ? ', your note' : ''}{publicZap && zapOffered ? ' and your public zap' : ''}. Nothing from your trades.</p>
        {error && <p className="hint warn" role="alert">{error}</p>}
        <button type="button" className="btn primary wide" disabled={step === 'working' || !chosen} onClick={() => create(pay, { sats: chosen, comment, publicZap: publicZap && zapOffered })}>{step === 'working' ? 'Creating invoice…' : `Create invoice for ${chosen ? chosen.toLocaleString('en-US') : '…'} sats`}</button>
      </>}

      {step === 'invoice' && invoice && <>
        <p><strong>Pay {satsLabel(invoice.sats)}</strong> <span className="dim">· expires in {countdown}</span></p>
        <Qr text={invoice.pr} />
        <div className="actions"><a className="btn primary" href={`lightning:${invoice.pr}`}>Open in wallet</a><Copy text={invoice.pr} label="Copy invoice" /></div>
        {state.watching
          ? <p role="status" className="dim">Waiting for your payment. This page checks automatically.</p>
          : <><p className="dim">This provider cannot confirm payments to us. Tell us once you have paid.</p><button type="button" className="btn ghost" onClick={confirmPaid}>I've paid</button></>}
      </>}

      {step === 'expired' && <>
        <p className="hint warn" role="status">That invoice expired. Nothing was charged.</p>
        <button type="button" className="btn primary" onClick={again}>Create a new invoice</button>
      </>}

      {step === 'paid' && receipt && <>
        <article className="card support-receipt" aria-label="Receipt">
          <h3>{satsLabel(receipt.sats)} received</h3>
          <dl><dt>To</dt><dd>{receipt.provider}</dd><dt>When</dt><dd>{new Date(receipt.at * 1000).toLocaleString()}</dd><dt>Payment hash</dt><dd className="mono">{shortHash(receipt.paymentHash)}</dd><dt>Status</dt><dd>{PROOF_TEXT[receipt.proof]}{receipt.zap ? ' · public Nostr zap' : ''}</dd></dl>
        </article>
        <div className="actions"><Copy text={receiptText(receipt)} label="Copy receipt" /><button type="button" className="btn primary" onClick={close}>Done</button></div>
      </>}
    </div>
  </div>
}
