import { useRef, useState } from 'react'
import { decode } from 'nostr-tools/nip19'
import { parseAddress, resolveAddress, requestInvoice, waitForPayment, isZapReceipt } from '../support/lnurl.js'

export const DEFAULT_SUPPORT_NPUB = 'npub17cth6et9yp0ejv2gwfxzcjucek7msfpqa5pajlv8r4jkzjaxkkvqapeytq'
export const PRESETS = [1000, 5000, 21000]

// The button shows only when a Lightning address is configured, so nothing in
// the app breaks or contacts a provider before then.
export function supportConfig(env = import.meta.env) {
  let address = null, recipient = null
  try { const { user, domain } = parseAddress(env.VITE_SUPPORT_LN_ADDRESS); address = `${user}@${domain}` } catch { /* Not configured. */ }
  try { const d = decode((env.VITE_SUPPORT_NPUB ?? DEFAULT_SUPPORT_NPUB).trim()); if (d.type === 'npub') recipient = d.data } catch { /* No public zaps. */ }
  return { address, recipient }
}

const friendly = error => error instanceof TypeError || /fetch|network|load failed/i.test(error?.message || '')
  ? 'Your browser could not reach the payment provider. You can still pay the address below from your wallet.'
  : error?.message || 'Something went wrong.'

// Support flow: closed → loading → amount → working → invoice → paid | expired,
// with a fallback that just shows the address. Nothing here touches trades.
export function useSupport({ address, recipient, signer, client, fetcher = fetch, interval = 3000 }) {
  const [state, setState] = useState({ step: 'closed' })
  const run = useRef(null)
  const stop = () => { run.current?.abort(); run.current = null }

  async function open() {
    stop()
    const controller = run.current = new AbortController()
    setState({ step: 'loading' })
    try {
      const pay = await resolveAddress(address, fetcher)
      if (!controller.signal.aborted) setState({ step: 'amount', pay })
    } catch (e) { if (!controller.signal.aborted) setState({ step: 'fallback', error: friendly(e) }) }
  }
  function close() { stop(); setState({ step: 'closed' }) }

  async function create(pay, { sats, comment, publicZap }) {
    stop()
    const controller = run.current = new AbortController()
    setState({ step: 'working', pay })
    try {
      const zap = publicZap && signer && recipient ? { signer, recipient, relays: client?.relays?.slice(0, 3) ?? [] } : null
      const invoice = await requestInvoice(pay, { sats, comment, zap }, { fetcher })
      if (controller.signal.aborted) return
      const since = Math.floor(Date.now() / 1000) - 60
      // With no payment-check link, a public zap can still be confirmed by its relay receipt.
      const findReceipt = invoice.zapJson && !invoice.verify && client?.query
        ? async () => (await client.query({ kinds: [9735], '#p': [recipient], since })).some(e => isZapReceipt(e, invoice, pay)) : undefined
      // watching: this page can tell by itself; otherwise the person confirms.
      setState({ step: 'invoice', pay, invoice, watching: !!(invoice.verify || findReceipt) })
      const result = await waitForPayment(invoice, { fetcher, findReceipt, interval, signal: controller.signal })
      if (controller.signal.aborted) return
      if (result.settled) setState({ step: 'paid', receipt: receiptFor(pay, invoice, result.proof, !!zap) })
      else setState({ step: 'expired', pay })
    } catch (e) { if (!controller.signal.aborted) setState({ step: 'amount', pay, error: friendly(e) }) }
  }

  // Only offered when the provider gives no way to check, and labelled as such.
  function confirmPaid() {
    if (state.step !== 'invoice') return
    stop()
    setState({ step: 'paid', receipt: receiptFor(state.pay, state.invoice, 'unconfirmed', false) })
  }
  const again = () => state.pay && setState({ step: 'amount', pay: state.pay })

  return { state, open, close, create, confirmPaid, again }
}

function receiptFor(pay, invoice, proof, zap) {
  return { sats: invoice.sats, at: Math.floor(Date.now() / 1000), provider: pay.address, paymentHash: invoice.paymentHash, proof, zap }
}
export const PROOF_TEXT = {
  preimage: 'Confirmed with proof of payment',
  provider: 'Confirmed by the payment provider',
  'zap-receipt': 'Confirmed by a Nostr zap receipt',
  unconfirmed: 'Not confirmed: you told us you paid',
}
export const receiptText = r => [
  'wot-pay support receipt',
  `${r.sats.toLocaleString('en-US')} sats to ${r.provider}`,
  new Date(r.at * 1000).toLocaleString(),
  `Payment hash: ${r.paymentHash}`,
  `${PROOF_TEXT[r.proof]}${r.zap ? ' · public Nostr zap' : ''}`,
].join('\n')
