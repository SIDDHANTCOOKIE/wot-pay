import { useEffect, useState } from 'react'
import { quotePrice } from '../marketplace/pricing.js'
import { inrPerBtc } from './rate.js'
import { rupees, sats } from './ui.jsx'

export default function QuotePreview({ draft, onBack }) {
  const [amount, setAmount] = useState(String(draft.inr || ''))
  const [rateType, setRateType] = useState('market')
  const [premium, setPremium] = useState('0')
  const [fixedRate, setFixedRate] = useState('')
  const [reference, setReference] = useState(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    let live = true
    const refresh = async () => {
      const value = await inrPerBtc({ refresh: true })
      if (live) { setReference(value ? { inr: value, at: Date.now() } : null); setNow(Date.now()) }
    }
    refresh()
    const id = setInterval(refresh, 60_000)
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => { live = false; clearInterval(id); clearInterval(clock) }
  }, [])
  let quote, error
  try { quote = quotePrice({ inr: amount, rateType, premium, fixedRate, reference, now }) }
  catch (e) { error = e.message }
  return <section className="screen">
    <button className="back" onClick={onBack}>← Change QR</button>
    <h1>Review your payment</h1>
    <p className="lede">Compare the cost before choosing a payer.</p>
    <div className="card"><h2>{draft.payee || 'UPI payee'}</h2><p className="mono">{draft.vpa}</p><p className="dim">These payment details stay in this browser. This preview does not publish them.</p></div>
    <label className="field">Merchant receives (₹)<input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} /></label>
    <label className="field">Pricing<select value={rateType} onChange={e => setRateType(e.target.value)}><option value="market">Market rate + premium / discount</option><option value="fixed">Fixed sats per ₹</option></select></label>
    {rateType === 'market' ? <label className="field">Premium / discount (%)<input inputMode="text" value={premium} onChange={e => setPremium(e.target.value)} /><small>Use a minus sign for a discount. Any positive resulting rate is allowed.</small></label> : <label className="field">Sats per ₹<input inputMode="decimal" value={fixedRate} onChange={e => setFixedRate(e.target.value)} /></label>}
    <p className="dim">{reference && now - reference.at < 300000 ? `Reference: ${rupees(reference.inr)} / BTC. Refreshed every minute.` : 'Reference unavailable or stale. You can enter a fixed rate.'}</p>
    {quote ? <div className="card price-breakdown"><h2>Estimated cost</h2><dl>
      <dt>Payer receives</dt><dd>{sats(quote.payerSats)}</dd>
      <dt>wot-pay fee · 1%</dt><dd>{sats(quote.serviceFeeSats)}</dd>
      <dt>Funding costs</dt><dd>Not yet quoted</dd>
      <dt>Subtotal</dt><dd>{sats(quote.totalSats)} + funding costs</dd>
    </dl><p className="dim">The exact quote will lock when both people agree. The fee is separate from the payer’s earnings.</p></div> : <p role="status" className="hint">{error}</p>}
    <div className="card"><h2>Protected trades are being prepared</h2><p>Private matching, mint verification and arbitration must be ready before you can fund a trade. No payment is requested here.</p><button className="btn primary wide" disabled>Choose a payer · coming soon</button></div>
    <details><summary>Service fee and refunds</summary><p>The official client’s fee is 1% of the accepted payer quote, rounded up to a whole sat, with no flat fee. Other clients can bypass it. Refunds are reviewed and sent manually.</p><p>Before the payer starts payment, cancellation, expiry or failed activation qualifies for a service-fee refund. Once payment starts, the reviewed dispute outcome determines any fee refund. Escrow recovery never depends on paying this fee.</p></details>
  </section>
}
