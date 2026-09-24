// Parse a UPI payment QR: upi://pay?pa=<vpa>&pn=<name>&am=<amount>&cu=INR&tn=<note>
export function parseUpi(text) {
  if (typeof text !== 'string') return null
  const t = text.trim()
  if (!/^upi:\/\/pay\?/i.test(t)) return null
  const params = new URLSearchParams(t.slice(t.indexOf('?') + 1))
  const pa = params.get('pa')?.trim()
  if (!pa || !/^[a-zA-Z0-9.\-_]{1,256}@[a-zA-Z]{2,64}$/.test(pa)) return null
  const cu = params.get('cu')
  if (cu && cu.toUpperCase() !== 'INR') return null
  const am = Number(params.get('am'))
  const okAmount = Number.isFinite(am) && am > 0 && am <= 500000
  return {
    vpa: pa,
    payee: params.get('pn')?.trim() || undefined,
    inr: okAmount ? Math.round(am * 100) / 100 : undefined,
    note: params.get('tn')?.trim() || undefined,
  }
}

// Link that opens GPay/PhonePe/Paytm with the payment filled in.
export function upiLink({ vpa, payee, inr, note }) {
  const q = new URLSearchParams({ pa: vpa, cu: 'INR' })
  if (payee) q.set('pn', payee)
  if (inr) q.set('am', Number(inr).toFixed(2))
  if (note) q.set('tn', note)
  return `upi://pay?${q.toString()}`
}
