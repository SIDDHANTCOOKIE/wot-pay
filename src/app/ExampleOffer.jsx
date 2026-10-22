import { useState } from 'react'

const KEY = 'wot-pay:example-hidden'
export default function ExampleOffer() {
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(KEY) === '1' } catch { return false } })
  function change(next) {
    setHidden(next)
    try { next ? localStorage.setItem(KEY, '1') : localStorage.removeItem(KEY) } catch { /* Browsing still works without storage. */ }
  }
  return <>
    <details className="how-it-works"><summary>How it works</summary><p>Request a QR payment, agree on a payer’s quote, fund verified escrow, then confirm the UPI payment and release sats together. Protected trading is not enabled yet.</p><button className="btn ghost" onClick={() => change(false)}>Show example offer</button></details>
    {!hidden && <article className="card example-offer" aria-label="Simulated example offer">
      <div className="row"><strong>Example · not a live offer</strong><button className="btn ghost" aria-label="Hide example offer" onClick={() => change(true)}>×</button></div>
      <h2>Pay ₹500 · receive 5,000 sats</h2>
      <p>A requester needs a merchant QR paid. A payer earns the agreed sats for paying it.</p>
      <p className="dim">Illustrative price only. No real payee, payment button or reputation. This example is never sent to relays or included in offer counts.</p>
    </article>}
  </>
}
