import { useEffect, useState } from 'react'
import { parsePrivate } from '../marketplace/protocol.js'
import { upiLink } from '../upi.js'
import { rupees, sats, Copy } from './ui.jsx'

const clock=seconds=>new Date(seconds*1000).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})
const day=seconds=>new Date(seconds*1000).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'})

export default function ProtectedTrades({ market, signer }) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  const run=async fn=>{setBusy(true);setError('');try{await fn()}catch(e){setError(e.message)}finally{setBusy(false);await market.reload().catch(()=>{})}}
  const requests=market.records.filter(r=>r.value.kind==='request'&&r.value.incoming&&!r.value.proposal)
  const pending=market.records.filter(r=>r.id.startsWith('outbox:')&&r.value.status==='pending')
  if(!signer)return null
  return <div>
    <h2>Private marketplace trades</h2>
    {market.trades.length>0&&pending.length===0&&<button className="btn ghost" disabled={busy} onClick={()=>run(market.retry)}>Reconcile private message delivery</button>}
    {pending.length>0&&<div className="card"><p>{pending.length} private message(s) awaiting delivery. Retry preserves the same encrypted message.</p><button className="btn ghost" disabled={busy} onClick={()=>run(market.retry)}>Retry private delivery</button></div>}
    {requests.map(row=><QuoteRequest key={row.id} row={row} market={market} busy={busy} run={run}/>)}
    {!market.trades.length&&!requests.length&&<p className="dim">Your private quotes and protected trades will appear here.</p>}
    {market.trades.map(row=><PrivateTrade key={row.id} row={row} market={market} signer={signer} busy={busy} run={run}/>)}
    {(error||market.error)&&<p role="alert" className="hint warn">{error||market.error}</p>}
  </div>
}
function QuoteRequest({row,market,busy,run}) {
  const m=parsePrivate(row.value.request),payerSide=row.value.listing.type==='payer-listing',[funding,setFunding]=useState('0'),[release,setRelease]=useState('0'),[price,setPrice]=useState(String(m.payload.payerSats))
  return <div className="card"><h3>Quote request · {rupees(m.payload.paise/100)}</h3><label className="field">Payer compensation (sats)<input value={price} onChange={e=>setPrice(e.target.value)}/></label><details><summary>Mint fee allowances</summary><label className="field">Funding including fee transfer (sats)<input value={funding} onChange={e=>setFunding(e.target.value)}/></label><label className="field">Escrow release (sats)<input value={release} onChange={e=>setRelease(e.target.value)}/></label><p>Both parties see these allowances before committing.</p></details>{payerSide&&<p className="dim">Sending this offer commits you to these exact terms for five minutes. If the requester funds escrow in time, you pay the merchant.</p>}<button className="btn primary" disabled={busy} onClick={()=>run(()=>market.propose(row,Number(price),Number(funding),Number(release)))}>{payerSide?'Offer these exact terms':'Send proposal to payer'}</button></div>
}
// The invoice comes straight from the agreed mint, never from the counterparty.
// While it is open the page checks for payment every few seconds.
function LightningInvoice({row,view,market,busy,run}) {
  const op=row.value.lightningOperation,[waiting,setWaiting]=useState('')
  const open=Math.floor(Date.now()/1000)<=view.fundBy
  useEffect(()=>{const id=setInterval(()=>market.completeLightning(row).catch(()=>{}),5000);return()=>clearInterval(id)},[row.id])
  return <div className="card"><h4>Pay {sats(row.value.agreement.escrowSats)} by Lightning</h4>
    <p className="dim">Invoice issued by the mint at {new URL(row.value.agreement.mint).hostname}. Paying it locks the sats in escrow; nobody, including wot-pay, can take them alone.</p>
    {open?<><a className="btn primary" href={`lightning:${op.invoice}`}>Open in Lightning wallet</a><Copy text={op.invoice}/><p className="fine">Pay before {clock(view.fundBy)}. A later payment is refunded, not used.</p></>:<p className="hint warn">The funding window has closed. Do not pay this invoice now; if you already paid, check below and the escrow will be refunded.</p>}
    <button className="btn ghost" disabled={busy} onClick={()=>run(async()=>setWaiting(await market.completeLightning(row)?'':'Payment not received yet. This page keeps checking.'))}>I paid · check now</button>{waiting&&<p role="status" className="dim">{waiting}</p>}</div>
}
// Anyone in the trade can confirm with the mint that the escrow still exists.
function EscrowCheck({row,market}) {
  const a=row.value.agreement,[result,setResult]=useState(null),[error,setError]=useState('')
  const label={locked:'Locked and unspent at the mint',spent:'Released by the mint',pending:'Being settled at the mint'}
  return <details className="trust"><summary>Where are my sats?</summary>
    <p>wot-pay never holds your money. The mint at {new URL(a.mint).hostname} holds it, locked so that no single person can move it: any two of the requester, payer and arbitrator together, or the requester alone after {day(a.refundAfter)}.</p>
    <button className="btn ghost" onClick={async()=>{setError('');try{setResult(await market.checkEscrow(row))}catch(e){setError(e.message)}}}>Check at the mint now</button>
    {result&&<p role="status">{sats(result.sats)} · {label[result.state]} · checked {new Date(result.checkedAt).toLocaleTimeString()}</p>}{error&&<p className="hint warn">{error}</p>}</details>
}
function PrivateTrade({row,market,signer,busy,run}) {
  const [token,setToken]=useState(''),[note,setNote]=useState(''),[requesterAmount,setRequesterAmount]=useState('0'),[payerAmount,setPayerAmount]=useState(String(row.value.agreement.payerSats)),[fee,setFee]=useState('0')
  const a=row.value.agreement,v=row.view,id=row.id.slice(6),requester=signer.pubkey===a.requester
  const payer=signer.pubkey===a.payer,arbitrator=signer.pubkey===a.arbitrator
  const [collected,setCollected]=useState(''),[arbKey,setArbKey]=useState('')
  const latest=v.events.filter(e=>['resolution','resolution-approve'].includes(e.action)).at(-1)?.payload.operation||row.value.resolutionOperation
  const act=(type,payload={})=>run(()=>market.action(row,type,payload))
  return <article className="card private-trade">
    <h3>{rupees(a.paise/100)} · {sats(a.payerSats)}</h3><p role="status">{v.status.replaceAll('-',' ')}</p>
    <p>You are the {requester?'requester':signer.pubkey===a.payer?'payer':'arbitrator'}.</p>
    <dl className="agreement-terms"><dt>Merchant</dt><dd>{a.destination.payee||a.destination.vpa}</dd><dt>UPI ID · private</dt><dd>{a.destination.vpa}</dd><dt>Payer receives</dt><dd>{sats(a.payerSats)}</dd><dt>Platform fee</dt><dd>None</dd><dt>Release allowance</dt><dd>{sats(a.releaseFeeSats)}</dd><dt>Funding allowance</dt><dd>{sats(a.fundingFeeSats)}</dd><dt>Maximum requester cost</dt><dd>{sats(a.escrowSats+a.fundingFeeSats)}</dd></dl>
    {row.value.proofs?.length>0&&<EscrowCheck row={row} market={market}/>}
    <details><summary>Mint, arbitrator and agreement</summary><p>{a.mint}</p><p className="mono">Arbitrator: {a.arbitrator}</p><p className="mono">Agreement: {id}</p><p>Any two of the requester, payer and arbitrator can settle. From {day(a.refundAfter)} the requester alone can also refund unresolved escrow, so disputes must be resolved before then. Support cannot replace a signing key.</p></details>
    {payer&&v.needsPayerAccept&&<button className="btn primary" disabled={busy} onClick={()=>act('accept')}>Accept these exact terms</button>}
    {requester&&v.needsPayerAccept&&<p className="dim">Waiting for the payer to accept these exact terms.</p>}
    {v.canFund&&requester&&!row.value.lightningOperation&&!row.value.fundingOperation&&<div><p>The payer has committed to these exact terms. Accept by funding escrow before {clock(v.fundBy)}. There is no platform fee.</p><button className="btn primary" disabled={busy||!market.config.protectedEnabled} onClick={()=>run(()=>market.prepareLightning(row))}>Accept &amp; fund with Lightning</button><details><summary>Fund with ecash instead (advanced)</summary><p className="dim">Paste ecash you already hold at {new URL(a.mint).hostname}. It must cover escrow and disclosed mint costs.</p><textarea value={token} onChange={e=>setToken(e.target.value)} spellCheck={false} placeholder="Cashu funding token" aria-label="Funding token"/><button className="btn ghost" disabled={busy||!market.config.protectedEnabled||!token} onClick={()=>run(()=>market.fund(row,token))}>Accept &amp; fund with ecash</button></details>{!market.config.protectedEnabled&&<p className="dim">Deployment mint verification is still required. Real funding is disabled.</p>}</div>}
    {requester&&!v.funded&&row.value.lightningReady&&<LightningInvoice row={row} view={v} market={market} busy={busy} run={run}/>}
    {requester&&!v.funded&&row.value.fundingOperation&&<button className="btn ghost" disabled={busy||!market.config.protectedEnabled} onClick={()=>run(()=>market.fund(row,''))}>Reconcile saved funding operation</button>}
    {payer&&!v.funded&&v.notice&&<div><p className="dim">Escrow arrived. It is being verified at the mint automatically.</p><button className="btn ghost" disabled={busy} onClick={()=>run(()=>market.verifyIncomingFunding(row))}>Check escrow at the mint again</button></div>}
    {payer&&v.disputeDue&&<p className="hint warn" role="alert">The requester has not confirmed your payment for 24 hours. Report a problem now so the arbitrator can review it before {day(a.refundAfter)}, when the requester could refund alone.</p>}
    {requester&&v.refundable&&<div><p>The refund timelock has passed without a resolution. You can return the escrow to yourself alone.</p><button className="btn primary" disabled={busy||!market.config.protectedEnabled} onClick={()=>{if(window.confirm('Refund the full escrow to yourself? Only do this if the merchant was not paid.'))run(()=>market.timelockRefund(row))}}>Refund escrow to me</button></div>}
    {v.lateFunding&&!v.completed&&<p className="hint warn">{v.declined?'The payer declined this escrow':'Escrow arrived after the funding window'}. No UPI payment is due. Propose or approve a full refund to the requester.</p>}
    {payer&&v.funded&&!v.paymentStarted&&!v.declined&&!v.completed&&<button className="btn ghost" disabled={busy} onClick={()=>{if(window.confirm('Decline this escrow? You will not pay the merchant, and the requester can only be refunded.'))act('escrow-declined',{reason:note||'Payer declined before paying.'})}}>Decline escrow · refund only</button>}
    {v.canPay&&payer&&<div><p>Escrow verified. Check the exact payee and amount once more in your UPI app. If the requester does not confirm after you pay, report a problem well before {day(a.refundAfter)}, when they could refund alone.</p><button className="btn primary" disabled={busy} onClick={()=>run(async()=>{await market.action(row,'payment-report',{status:'started'});window.location.href=upiLink({vpa:a.destination.vpa,payee:a.destination.payee,inr:a.paise/100,note:a.destination.note})})}>Start payment in UPI app</button></div>}
    {v.funded&&!v.completed&&!v.lateFunding&&payer&&!v.payerRelease&&v.paymentStarted&&<div><button className="btn primary" disabled={busy} onClick={()=>run(()=>market.reportPaid(row))}>I paid · request release</button><p className="fine">This reports the payment and signs a release of {sats(a.escrowSats)} to you. It completes when the requester confirms the merchant was paid.</p></div>}
    {v.funded&&!v.completed&&payer&&<div className="actions">{['pending','failed'].map(status=><button className="btn ghost" disabled={busy} key={status} onClick={()=>act('payment-report',{status})}>UPI {status}</button>)}</div>}
    {requester&&v.payerRelease&&<div><button className="btn primary" disabled={busy||!market.config.protectedEnabled} onClick={()=>{if(window.confirm(`Release ${v.payerRelease.allocation.payerSats} sats to the payer? Only confirm once the merchant has received the payment.`))run(()=>market.confirmAndRelease(row))}}>Merchant received it · release payment</button><p className="fine">Adds your signature to the payer's release and settles it at the mint.</p></div>}
    {v.funded&&!v.completed&&requester&&!v.payerRelease&&!v.merchantConfirmed&&<button className="btn ghost" disabled={busy} onClick={()=>act('merchant-confirmed')}>Merchant confirms credit</button>}
    {v.dispute&&!arbitrator&&<button className="btn ghost" disabled={busy} onClick={()=>run(()=>market.escalate(row))}>Send private case to agreed arbitrator</button>}
    {arbitrator&&!row.value.escrowKey&&<div><p className="dim">On your offline device, run <span className="mono">npm run arbitrator:keys -- derive &lt;seed-file&gt; {a.escrowKeys.arbitrator}</span> and paste the result. Only this trade's key is exposed here.</p><label className="field">This trade's arbitrator escrow key<input type="password" value={arbKey} onChange={e=>setArbKey(e.target.value)} autoComplete="off"/></label><button className="btn ghost" disabled={busy} onClick={()=>run(async()=>{await market.importArbitratorKey(row,arbKey);setArbKey('')})}>Unlock case signing</button></div>}
    {!v.completed&&v.events.some(e=>e.action==='payout')&&<button className="btn ghost" disabled={busy} onClick={()=>run(()=>market.verifyIncomingPayout(row))}>Check settled payout at the mint again</button>}
    {v.offered&&!v.completed&&<details><summary>Cancellation, evidence or a problem</summary><textarea value={note} onChange={e=>setNote(e.target.value)} maxLength={1000} placeholder="Private explanation or payment reference" aria-label="Private case evidence"/><p className="dim">A report is evidence to review, not proof that a payment succeeded. Never pay a second time while UPI is pending.</p><div className="actions"><button className="btn ghost" disabled={busy} onClick={()=>act('evidence',{note})}>Share private evidence</button><button className="btn ghost" disabled={busy} onClick={()=>act('cancel-request',{reason:note})}>Request cancellation</button><button className="btn ghost danger" disabled={busy} onClick={()=>act('dispute',{reason:note})}>Report a problem</button></div>{v.cancellation&&v.cancellation.pubkey!==signer.pubkey&&<button className="btn ghost" disabled={busy} onClick={()=>act('cancel-agree',{requestId:v.cancellation.id})}>Agree to requested cancellation</button>}{v.mayEscalate&&<p>The response deadline passed. Escalate to the agreed panel; funds stay locked.</p>}</details>}
    {v.funded&&!v.completed&&<details><summary>Propose release, refund or split</summary><p>Both participants must approve a split. No deadline or screenshot moves funds automatically.</p><label className="field">Requester receives (sats)<input value={requesterAmount} onChange={e=>setRequesterAmount(e.target.value)}/></label><label className="field">Payer receives (sats)<input value={payerAmount} onChange={e=>setPayerAmount(e.target.value)}/></label><label className="field">Mint fee (sats)<input value={fee} onChange={e=>setFee(e.target.value)}/></label><button className="btn ghost" disabled={busy} onClick={()=>run(()=>market.proposeResolution(row,{requesterSats:Number(requesterAmount),payerSats:Number(payerAmount),mintFeeSats:Number(fee),reason:note}))}>Prepare exact payout</button></details>}
    {latest&&!v.completed&&<div className="card"><h4>Review payout proposal</h4><p>Requester: {sats(latest.allocation.requesterSats)} · payer: {sats(latest.allocation.payerSats)} · mint fee: {sats(latest.allocation.mintFeeSats)}</p><p>Signing authorizes these exact outputs. A sent signature cannot be revoked.</p><button className="btn primary" disabled={busy} onClick={()=>run(()=>market.approveResolution(row,latest))}>Sign this payout</button><button className="btn ghost" disabled={busy||!market.config.protectedEnabled} onClick={()=>run(()=>market.settle(row,latest))}>Submit signed payout</button></div>}
    {v.completed&&!arbitrator&&<div><p>Escrow settled. Completed payouts cannot be clawed back.</p>{row.value.payouts?.[requester?'requester':'payer']?.length>0&&<button className="btn primary" disabled={busy||!market.config.protectedEnabled} onClick={()=>run(async()=>setCollected(await market.collectPayout(row)))}>Collect payout for external Cashu wallet</button>}{collected&&<div><p>Private bearer token. Import into your Cashu wallet once; anyone with this token can spend it.</p><Copy text={collected}/></div>}<textarea value={note} onChange={e=>setNote(e.target.value)} maxLength={1000} aria-label="Follow-up case"/><button className="btn ghost" disabled={busy} onClick={()=>act('follow-up',{reason:note})}>Open follow-up case</button></div>}
    <details><summary>Private activity</summary>{v.events.map(e=><p key={e.id}>{e.pubkey===signer.pubkey?'You':e.pubkey===a.arbitrator?'Arbitrator':'Counterparty'} · {e.action.replaceAll('-',' ')}{e.payload.note?` · ${e.payload.note}`:''}{e.payload.status?` · ${e.payload.status}`:''}</p>)}</details>
  </article>
}
