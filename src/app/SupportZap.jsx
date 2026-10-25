import { useEffect, useRef, useState } from 'react'
import { decode, npubEncode } from 'nostr-tools/nip19'
import QRCode from 'qrcode'
import { createSupportInvoice, validZapReceipt } from '../zap.js'
import { Copy } from './ui.jsx'

export const DEFAULT_SUPPORT_NPUB = 'npub17cth6et9yp0ejv2gwfxzcjucek7msfpqa5pajlv8r4jkzjaxkkvqapeytq'
export function supportProfile(value) {
  try { const parsed=decode(value?.trim()||'');return parsed.type==='npub'?`nostr:${npubEncode(parsed.data)}`:null }catch{return null}
}
export default function SupportZap({npub=import.meta.env.VITE_SUPPORT_NPUB ?? DEFAULT_SUPPORT_NPUB,client}) {
  const [open,setOpen]=useState(false),[sats,setSats]=useState('1000'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[zap,setZap]=useState(null),[qr,setQr]=useState(''),[received,setReceived]=useState(false),[now,setNow]=useState(Date.now())
  const dialog=useRef(null),generation=useRef(0)
  const href=supportProfile(npub)
  useEffect(()=>{if(open)dialog.current?.showModal();else dialog.current?.close()},[open])
  useEffect(()=>{if(!zap)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[zap])
  useEffect(()=>{
    if(!zap||!client)return
    let live=true
    const accept=event=>{if(live&&validZapReceipt(event,zap))setReceived(true)}
    const filter={kinds:[9735],'#p':[zap.recipient],since:zap.request.created_at-60}
    const close=client.subscribe({...filter,'#t':undefined},accept)
    client.queryIdentity(filter).then(events=>events.forEach(accept)).catch(()=>{})
    return()=>{live=false;close()}
  },[zap,client])
  if(!href)return null
  const close=()=>{generation.current++;setOpen(false);setBusy(false);setZap(null);setQr('');setError('');setReceived(false)}
  async function generate() {
    if(busy)return
    const current=++generation.current
    setBusy(true);setError('');setZap(null);setQr('');setReceived(false)
    try {
      if(!client)throw new Error('Connect to the relays before requesting an invoice.')
      const result=await createSupportInvoice({client,recipient:decode(npub.trim()).data,sats,lightningAddress:import.meta.env.VITE_SUPPORT_LIGHTNING_ADDRESS ?? (npub===DEFAULT_SUPPORT_NPUB?'crystalinfinity706645@getalby.com':undefined)})
      const image=await QRCode.toDataURL(result.invoice.toUpperCase(),{width:256,margin:2,errorCorrectionLevel:'M'})
      if(generation.current!==current)return
      setNow(Date.now());setZap(result);setQr(image)
    }catch(e){if(generation.current===current)setError(e.message)}finally{if(generation.current===current)setBusy(false)}
  }
  const expired=zap&&now>=zap.expiresAt*1000
  return <>
    <button type="button" className="support-link" onClick={()=>setOpen(true)}>Support us</button>
    <dialog ref={dialog} className="support-dialog" aria-labelledby="support-title" onCancel={event=>{event.preventDefault();close()}} onClick={event=>{if(event.target===dialog.current)close()}}>
      <div className="row"><h2 id="support-title">Support wot-pay</h2><button type="button" className="support-close" aria-label="Close support" onClick={close}>×</button></div>
      <p className="dim">An optional zap to help us build. Trading stays free.</p>
      {!zap&&<><label className="field">Amount (sats)<input inputMode="numeric" value={sats} onChange={event=>setSats(event.target.value)} disabled={busy}/></label><div className="support-presets">{[100,1000,5000].map(amount=><button type="button" className="btn ghost" key={amount} disabled={busy} onClick={()=>setSats(String(amount))}>{amount.toLocaleString()} sats</button>)}</div><p className="fine">No sign-in required. Payment happens in your Lightning wallet.</p><button type="button" className="btn primary wide" disabled={busy} onClick={generate}>{busy?'Requesting invoice…':'Generate Lightning invoice'}</button></>}
      {zap&&<><p className="support-amount">{zap.sats.toLocaleString()} sats</p>{received?<p role="status">Zap receipt received. Thank you for supporting wot-pay.</p>:expired?<p role="status">This invoice expired. Generate a new one to continue.</p>:<><img className="support-qr" src={qr} alt="Lightning invoice QR code" width="256" height="256"/><a className="btn primary wide" href={`lightning:${zap.invoice}`}>Pay in Lightning wallet</a><Copy text={zap.invoice} label="Copy invoice"/><p className="fine">Waiting for a wallet payment. Generating an invoice does not send sats.</p></>}<button type="button" className="btn ghost" onClick={()=>{generation.current++;setZap(null);setQr('');setReceived(false)}}>{received?'Send another zap':'Change amount / new invoice'}</button></>}
      {error&&<p role="alert" className="hint warn">{error}</p>}
      <a className="support-profile" href={href}>View support profile in Nostr</a>
    </dialog>
  </>
}
