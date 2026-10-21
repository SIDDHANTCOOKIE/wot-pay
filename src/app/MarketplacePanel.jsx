import { useState, useEffect } from 'react'
import { newRecoverySecret } from '../recovery.js'
import { decimalUnits, quotePrice } from '../marketplace/pricing.js'
import { inrPerBtc } from './rate.js'
import { httpsOrigin } from '../marketplace/protocol.js'
import { Name, rupees, sats } from './ui.jsx'

export default function MarketplacePanel({ market, signer, board, mode = 'earn', draft, onRequireIdentity }) {
  const [editing,setEditing]=useState(false),[mint,setMint]=useState(''),[min,setMin]=useState('100'),[max,setMax]=useState('1000'),[rateType,setRateType]=useState('market'),[rate,setRate]=useState('0')
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[amount,setAmount]=useState(String(draft?.inr||'')),[bid,setBid]=useState(''),[selected,setSelected]=useState(null)
  const [sort,setSort]=useState('trust'),[mintFilter,setMintFilter]=useState('')
  const [relationship,setRelationship]=useState('all'),[reference,setReference]=useState(null)
  useEffect(()=>{if(mode!=='pay')return;let live=true;const update=async()=>{const inr=await inrPerBtc({refresh:true});if(live)setReference(inr?{inr,at:Date.now()}:null)};update();const timer=setInterval(update,60000);return()=>{live=false;clearInterval(timer)}},[mode])
  useEffect(()=>setAmount(String(draft?.inr||'')),[draft?.inr])
  const destination=draft?Object.fromEntries(['vpa','payee','note'].filter(k=>typeof draft[k]==='string').map(k=>[k,draft[k]])):null
  const run=async fn=>{setBusy(true);setError('');try{await fn()}catch(e){setError(e.message)}finally{setBusy(false);await market.reload().catch(()=>{})}}
  const requireAccount=()=>{if(!signer){onRequireIdentity?.();return false}return true}
  const own=market.records.filter(r=>r.value.kind==='listing')
  const estimate=listing=>{try{return quotePrice({inr:amount,rateType:listing.rateType,fixedRate:listing.rate,premium:listing.rate,reference})}catch{return null}}
  const listings=market.listings.filter(l=>l.type===(mode==='pay'?'payer-listing':'qr-request')&&l.pubkey!==signer?.pubkey&&(!mintFilter||l.mint===mintFilter)&&(relationship!=='direct'||board.ranker.explain(l.pubkey).hops===1)).sort((a,b)=>sort==='newest'?b.created_at-a.created_at:sort==='cost'?(estimate(a)?.totalSats??Infinity)-(estimate(b)?.totalSats??Infinity):sort==='sats'&&a.type==='qr-request'?b.sats/b.paise-a.sats/a.paise:board.ranker.explain(b.pubkey).score-board.ranker.explain(a.pubkey).score||b.created_at-a.created_at)
  async function publish() {
    if(!requireAccount())return
    const common={v:3,listingId:newRecoverySecret(),mint:httpsOrigin(mint),available:true,expiresAt:Math.floor(Date.now()/1000)+86400}
    const listing=mode==='earn'?{...common,type:'payer-listing',minPaise:Number(decimalUnits(min)),maxPaise:Number(decimalUnits(max)),rateType,rate}:{...common,type:'qr-request',paise:Number(decimalUnits(amount)),sats:Number(bid)}
    if(mode==='pay'&&!destination?.vpa)throw new Error('Scan or paste a valid UPI QR first.')
    await market.publishListing(listing,mode==='pay'?destination:undefined);setEditing(false)
  }
  async function request(listing) {
    if(!requireAccount())return
    const paise=listing.type==='qr-request'?listing.paise:Number(decimalUnits(amount))
    let payerSats=Number(bid)
    if(!bid) {
      if(listing.type==='qr-request')payerSats=listing.sats
      else {const value=await inrPerBtc({refresh:true});payerSats=quotePrice({inr:amount,rateType:listing.rateType,fixedRate:listing.rate,premium:listing.rate,reference:value?{inr:value,at:Date.now()}:null}).payerSats}
    }
    if(listing.type==='payer-listing'&&!destination?.vpa)throw new Error('Scan or paste a valid UPI QR first.')
    await market.requestQuote(listing,paise,payerSats,destination)
    setSelected(null);setError('Private quote request sent. Continue in My trades.')
  }
  return <div className="marketplace-panel">
    <h2>{mode==='earn'?'Private QR requests':'Find a payer'}</h2>
    <p className="dim">Payment destinations are shared privately with the selected person. Quotes require both parties’ agreement before funding.</p>
    {market.config.limits?.tradePaise&&<p className="fine">Pilot limits: up to {rupees(market.config.limits.tradePaise/100)} per trade and {rupees(market.config.limits.dayPaise/100)} per day.</p>}
    {signer&&!market.supported&&<p className="hint">Private marketplace messages currently require a device identity. Your external signer can still browse.</p>}
    {signer&&market.supported&&!market.inbox&&<button className="btn primary" disabled={busy} onClick={()=>run(market.enableInbox)}>Enable private trade inbox</button>}
    <button className="btn ghost" disabled={busy||!!signer&&!market.supported} onClick={()=>{if(requireAccount())setEditing(!editing)}}>{mode==='earn'?'Create payer advertisement':'Publish a private QR request'}</button>
    {editing&&<div className="card">
      <label className="field">Cashu mint<input value={mint} onChange={e=>setMint(e.target.value)} placeholder="https://your-mint.example" /></label>
      {mode==='earn'?<>
        <label className="field">Minimum payment (₹)<input inputMode="decimal" value={min} onChange={e=>setMin(e.target.value)} /></label>
        <label className="field">Maximum payment (₹)<input inputMode="decimal" value={max} onChange={e=>setMax(e.target.value)} /></label>
        <label className="field">Rate type<select value={rateType} onChange={e=>{setRateType(e.target.value);setRate(e.target.value==='market'?'0':'')}}><option value="market">Market-linked</option><option value="fixed">Fixed sats per ₹</option></select></label>
        <label className="field">{rateType==='market'?'Premium / discount (%)':'Sats per ₹'}<input value={rate} onChange={e=>setRate(e.target.value)} /></label>
      </>:<>
        <label className="field">Merchant receives (₹)<input inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} /></label>
        <label className="field">Proposed payer compensation (sats)<input inputMode="numeric" value={bid} onChange={e=>setBid(e.target.value)} /></label>
      </>}
      <p className="fine">Only amount/rate, mint, identity and availability become public. Advertisement expires in 24 hours. No funds move when publishing.</p>
      <button className="btn primary" disabled={busy||!market.inbox} onClick={()=>run(publish)}>Publish advertisement</button>
    </div>}
    {own.map(row=>{const listing=JSON.parse(row.value.signed.content);return <div className="card" key={row.id}><div className="row"><span>Your {listing.type==='payer-listing'?'payer advertisement':'QR request'}</span><span>{listing.available?'Available':'Paused'}</span></div><button className="btn ghost" disabled={busy} onClick={()=>run(()=>market.publishListing({...listing,available:!listing.available,expiresAt:Math.floor(Date.now()/1000)+86400}))}>{listing.available?'Pause listing':'Make available'}</button></div>})}
    <label className="field">Sort offers<select value={sort} onChange={e=>setSort(e.target.value)}><option value="trust">Recommended · trust and history</option><option value="newest">Newest</option>{mode==='earn'?<option value="sats">Highest sats per ₹</option>:<option value="cost">Lowest estimated cost</option>}</select></label><details><summary>Filter offers</summary><label className="field">Mint<select value={mintFilter} onChange={e=>setMintFilter(e.target.value)}><option value="">All mints</option>{[...new Set(market.listings.map(l=>l.mint))].map(m=><option key={m}>{m}</option>)}</select></label><label className="field">Relationship<select value={relationship} onChange={e=>setRelationship(e.target.value)}><option value="all">Everyone</option><option value="direct">People I follow</option></select></label></details>
    {!listings.length&&<p className="empty">No matching private marketplace offers yet.</p>}
    {listings.map(listing=><div className="card" key={listing.id}>
      <Name pubkey={listing.pubkey} profiles={board.profiles}/>
      <h3>{listing.type==='payer-listing'?`${rupees(listing.minPaise/100)}–${rupees(listing.maxPaise/100)}`:`Pay ${rupees(listing.paise/100)} · receive ${sats(listing.sats)}`}</h3>
      {listing.type==='payer-listing'&&<p>{listing.rateType==='fixed'?`${listing.rate} sats per ₹`:`Market rate ${Number(listing.rate)>=0?'+':''}${listing.rate}%`}</p>}
      {listing.type==='payer-listing'&&<p className="dim">{estimate(listing)?`${sats(estimate(listing).totalSats)} platform fee: 0; mint costs quoted before acceptance.`:'Enter an amount; market prices need a fresh reference.'}</p>}
      <p className="dim">{new URL(listing.mint).hostname} · {board.ranker.explain(listing.pubkey).hops===1?'You follow them':'Review their trust history'}</p>
      <button className="btn primary" disabled={busy||!!signer&&(!market.supported||!market.inbox)} onClick={()=>{if(requireAccount())setSelected(listing.id)}}>Request a quote</button>
      {selected===listing.id&&<div>
        {listing.type==='payer-listing'&&<label className="field">Payment amount (₹)<input value={amount} onChange={e=>setAmount(e.target.value)}/></label>}
        <label className="field">Your sats quote (optional)<input inputMode="numeric" value={bid} onChange={e=>setBid(e.target.value)} placeholder={listing.type==='qr-request'?String(listing.sats):'Use the advertised rate'}/></label>
        <button className="btn primary" disabled={busy} onClick={()=>run(()=>request(listing))}>Send private request</button>
      </div>}
    </div>)}
    {(error||market.error)&&<p role="status" className="hint">{error||market.error}</p>}
  </div>
}
