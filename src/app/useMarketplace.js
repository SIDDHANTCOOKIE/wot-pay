import { useEffect, useMemo, useRef, useState } from 'react'
import { listingTemplate, parseListing, currentListings, contentHash, privateTemplate, parsePrivate, validateAgreement, tradeView, viewOf, MARKET_TAG, LISTING_KIND, QUOTE_LIFETIME, REFUND_DELAY } from '../marketplace/protocol.js'
import { createVault } from '../marketplace/vault.js'
import { deliverPrivate, inboxRelays } from '../marketplace/private.js'
import { createEscrowKey } from '../marketplace/escrow.js'
import { TERMS_VERSION } from '../marketplace/pricing.js'
import { marketplaceConfig, assertDeploymentAgreement } from '../marketplace/config.js'
import { newRecoverySecret } from '../recovery.js'
import { connectMint, prepareFunding, completeFunding, verifyFunding, prepareResolution, signResolution, completeResolution, validateResolutionOperation } from '../marketplace/escrow.js'
import { backupOperation, syncPrivateBackup } from '../marketplace/backup.js'
import { requireFreeSlot, validateResolution, payerCommitted } from '../marketplace/protocol.js'
import { getEncodedToken, getPubKeyFromPrivKey } from '@cashu/cashu-ts'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import { resolutionFingerprint, verifyPayout, prepareClaim, completeClaim } from '../marketplace/escrow.js'

export function useMarketplace(client, signer) {
  const [publicEvents,setPublicEvents] = useState(new Map())
  const [records,setRecords] = useState([])
  const [error,setError] = useState('')
  const [inbox,setInbox] = useState(false)
  const [inboxRevision,setInboxRevision] = useState(0)
  const [clock,setClock] = useState(Math.floor(Date.now()/1000))
  const supported = !!signer?.sealLocal
  const vault = useMemo(() => supported ? createVault(signer) : null,[signer,supported])
  const config = useMemo(() => marketplaceConfig(),[])
  const mintFor = agreement => connectMint(agreement,{restoreVerified:config.restoreMints.includes(agreement.mint)})
  const ingestQueue = useRef(Promise.resolve())
  const reload = async () => { if (vault) setRecords(await vault.snapshot()) }
  useEffect(()=>{
    if(!vault)return
    let running=false,live=true
    const repair=async()=>{if(running||!navigator.locks)return;running=true;try{await navigator.locks.request(`wot-pay:${signer.pubkey}:operations`,()=>syncPrivateBackup(vault,signer,fetch,client))}catch(e){if(live)setError(`Backup needs attention: ${e.message}`)}finally{running=false}}
    const timer=setInterval(repair,60000)
    window.addEventListener('online',repair)
    return()=>{live=false;clearInterval(timer);window.removeEventListener('online',repair)}
  },[vault,signer,client])
  useEffect(() => { const id=setInterval(()=>setClock(Math.floor(Date.now()/1000)),1000);return()=>clearInterval(id) },[])
  useEffect(() => {
    const accept = raw => { if(parseListing(raw)) setPublicEvents(prev=>new Map(prev).set(raw.id,raw)) }
    client.query({kinds:[LISTING_KIND],'#t':[MARKET_TAG]}).then(events=>events.forEach(accept)).catch(()=>setError('Marketplace relays are unavailable.'))
    return client.subscribe({kinds:[LISTING_KIND],'#t':[MARKET_TAG]},accept)
  },[client])
  useEffect(() => {
    setRecords([]);setInbox(false)
    if (!vault) return
    let live=true,close
    vault.snapshot().then(rows=>{if(live)setRecords(rows)}).catch(e=>setError(e.message))
    const receive = wrap => {
      ingestQueue.current=ingestQueue.current.then(async()=>{
        if(!live)return
        const signed=signer.openPrivate(wrap),message=signed&&parsePrivate(signed)
        if(!message)return
        if(message.action==='case') {
          const a=validateAgreement(message.payload.agreement)
          if(a.arbitrator!==signer.pubkey||![a.requester,a.payer].includes(message.pubkey)||await contentHash(a)!==message.agreementId)return
          const events=message.payload.events
          if(!Array.isArray(events)||events.length>200||events.some(e=>!parsePrivate(e)||parsePrivate(e).agreementId!==message.agreementId))return
          const view=tradeView(a,message.agreementId,events)
          if(!view.offered||!view.dispute)return
          const existing=await vault.read(`trade:${message.agreementId}`)
          const merged=[...new Map([...(existing?.value.events||[]),...events].map(e=>[e.id,e])).values()]
          await vault.write(`trade:${message.agreementId}`,{...existing?.value,kind:'trade',agreement:a,events:merged,evidence:existing?.value.evidence||{}},existing?.revision||0)
        } else if(message.action==='quote-request') {
          const listing=parseListing(message.payload.listing)
          if(!listing || listing.pubkey!==signer.pubkey || message.pubkey===signer.pubkey)return
          if(!Number.isSafeInteger(message.payload.paise)||message.payload.paise<=0||!Number.isSafeInteger(message.payload.payerSats)||message.payload.payerSats<=0||!/^(02|03)[0-9a-f]{64}$/.test(message.payload.escrowKey))return
          if(listing.type==='payer-listing'&&(message.payload.paise<listing.minPaise||message.payload.paise>listing.maxPaise))return
          if(listing.type==='qr-request'&&message.payload.paise!==listing.paise)return
          const id=`request:${message.agreementId}`
          if(!await vault.read(id))await vault.write(id,{kind:'request',incoming:true,request:signed,listing})
        } else if(message.action==='proposal') {
          const a=validateAgreement(message.payload.agreement)
          if(await contentHash(a)!==message.agreementId || ![a.requester,a.payer].includes(message.pubkey) || ![a.requester,a.payer].includes(signer.pubkey))return
          const request=await vault.read(`request:${message.payload.requestId}`)
          if(!request?.value.escrowKey || a.escrowKeys[a.requester===signer.pubkey?'requester':'payer']!==request.value.escrowKey.pubkey)return
          const original=parsePrivate(request.value.request),listing=request.value.listing
          if(listing.pubkey!==message.pubkey||a.mint!==listing.mint||a.listingId!==listing.listingId||a.paise!==original.payload.paise)return
          // Compare semantic destination fields, independent of JSON ordering.
          if(listing.type==='payer-listing'&&(a.requester!==signer.pubkey||a.payer!==message.pubkey||['vpa','payee','note'].some(k=>a.destination[k]!==original.payload.destination?.[k])))return
          if(listing.type==='qr-request'&&(a.payer!==signer.pubkey||a.requester!==message.pubkey))return
          // Arrival time on this device bounds deadlines a sender could backdate.
          if(!await vault.read(`trade:${message.agreementId}`))await vault.write(`trade:${message.agreementId}`,{kind:'trade',agreement:a,escrowKey:request.value.escrowKey,events:[signed],received:{[signed.id]:Math.floor(Date.now()/1000)},evidence:{}})
        } else {
          const row=await vault.read(`trade:${message.agreementId}`)
          if(!row || ![row.value.agreement.requester,row.value.agreement.payer,row.value.agreement.arbitrator].includes(message.pubkey) || row.value.events.some(e=>e.id===signed.id))return
          await vault.write(row.id,{...row.value,events:[...row.value.events,signed],received:{...row.value.received,[signed.id]:Math.floor(Date.now()/1000)}},row.revision)
        }
        if(live)await reload()
      }).catch(e=>setError(e.message))
    }
    client.queryIdentity({kinds:[10050],authors:[signer.pubkey]}).then(events=>{
      if(!live)return
      const urls=inboxRelays(events,signer.pubkey)
      setInbox(urls.length>0)
      if(urls.length)close=client.subscribePrivate(urls,signer.pubkey,receive)
    }).catch(e=>setError(e.message))
    return()=>{live=false;close?.()}
  },[client,signer,vault,inboxRevision])
  async function enableInbox() {
    const signed=await signer.sign({kind:10050,created_at:Math.floor(Date.now()/1000),tags:client.relays.map(url=>['relay',url]),content:''})
    await client.publish(signed);setInboxRevision(n=>n+1)
  }
  async function publishListing(listing,privateDestination) {
    if(!vault)throw new Error('Use a device identity for the private marketplace.')
    const id=`listing:${listing.listingId}`,previous=await vault.read(id)
    const signed=await signer.sign(listingTemplate(listing,Math.max(Math.floor(Date.now()/1000),(previous?.value.signed.created_at||0)+1)))
    await vault.write(id,{kind:'listing',signed,destination:privateDestination || previous?.value.destination || null,status:'pending'},previous?.revision||0)
    await client.publish(signed)
    setPublicEvents(prev=>new Map(prev).set(signed.id,signed))
    const stored=await vault.read(id)
    await vault.write(id,{...stored.value,status:'published'},stored.revision);await reload()
  }
  async function requestQuote(listing,paise,payerSats,destination) {
    if(!vault||!inbox)throw new Error('Enable your private inbox before requesting a quote.')
    const raw=publicEvents.get(listing.id)
    if(!raw||!currentListings([...publicEvents.values()],clock).some(l=>l.id===listing.id)||listing.pubkey===signer.pubkey)throw new Error('Choose an available offer from another person.')
    const requestId=newRecoverySecret(),escrowKey=createEscrowKey()
    const payload={listing:raw,paise,payerSats,escrowKey:escrowKey.pubkey}
    if(listing.type==='payer-listing')payload.destination=destination
    const signed=await signer.sign(privateTemplate(requestId,'quote-request',payload))
    await vault.write(`request:${requestId}`,{kind:'request',incoming:false,request:signed,listing,escrowKey})
    await deliverPrivate({client,signer,vault,to:listing.pubkey,signed});await reload()
  }
  // A payer commits by signing exact terms; first pause advertisements and
  // refuse a second commitment while another trade can still be funded.
  async function commitAsPayer(exceptId) {
    if(payerCommitted(signer.pubkey,await vault.snapshot(),exceptId))throw new Error('Finish or expire your existing accepted trade before accepting another.')
    for(const r of await vault.snapshot())if(r.value.kind==='listing') {
      const listing=JSON.parse(r.value.signed.content)
      if(listing.type==='payer-listing'&&listing.available)await publishListing({...listing,available:false})
    }
  }
  async function propose(requestRow,payerSats,fundingFeeSats=0,releaseFeeSats=0) {
    if(!config.ready)throw new Error('Configure the arbitrator panel before creating an agreement.')
    requestRow=await vault.read(requestRow.id)
    if(requestRow.value.proposal) {await deliverPrivate({client,signer,vault,to:parsePrivate(requestRow.value.request).pubkey,signed:requestRow.value.proposal});return reload()}
    const request=parsePrivate(requestRow.value.request),listing=requestRow.value.listing
    if(!requestRow.value.incoming||!listing.available||listing.expiresAt<=clock)throw new Error('Request is unavailable.')
    const localListing=await vault.read(`listing:${listing.listingId}`)
    const latest=localListing&&parseListing(localListing.value.signed)
    if(!latest?.available)throw new Error('Your listing is no longer available.')
    const requester=listing.type==='payer-listing'?request.pubkey:signer.pubkey,payer=requester===signer.pubkey?request.pubkey:signer.pubkey
    const escrowKey=createEscrowKey(),ownRole=requester===signer.pubkey?'requester':'payer'
    const panel=config.panel.find(p=>![requester,payer].includes(p.pubkey))
    if(!panel)throw new Error('No independent arbitrator is configured.')
    // A payer's proposal is also the payer's acceptance of these exact terms.
    if(ownRole==='payer')await commitAsPayer(null)
    const now=Math.floor(Date.now()/1000)
    const agreement=validateAgreement({v:3,termsVersion:TERMS_VERSION,nonce:newRecoverySecret(),listingId:listing.listingId,requester,payer,arbitrator:panel.pubkey,escrowKeys:{requester:ownRole==='requester'?escrowKey.pubkey:request.payload.escrowKey,payer:ownRole==='payer'?escrowKey.pubkey:request.payload.escrowKey,arbitrator:panel.escrowKey},mint:listing.mint,paise:request.payload.paise,payerSats,fundingFeeSats,releaseFeeSats,escrowSats:payerSats+releaseFeeSats,destination:listing.type==='payer-listing'?request.payload.destination:localListing.value.destination,createdAt:now,quoteExpiresAt:now+QUOTE_LIFETIME,refundAfter:now+QUOTE_LIFETIME+REFUND_DELAY})
    const id=await contentHash(agreement),signed=await signer.sign(privateTemplate(id,'proposal',{agreement,requestId:request.agreementId},now))
    await vault.write(`trade:${id}`,{kind:'trade',agreement,escrowKey,events:[signed],received:{[signed.id]:now},evidence:{}})
    await vault.write(requestRow.id,{...requestRow.value,proposal:signed},requestRow.revision)
    await deliverPrivate({client,signer,vault,to:request.pubkey,signed});await reload()
  }
  const own=(row,signed)=>({events:[...row.value.events,signed],received:{...row.value.received,[signed.id]:signed.created_at}})
  async function action(row,action,payload={}) {
    const fresh=await vault.read(row.id),a=fresh.value.agreement,view=viewOf(fresh,clock)
    const me=signer.pubkey
    if(![a.requester,a.payer].includes(me))throw new Error('Only participants can perform this action.')
    if(action==='accept') {
      if(me!==a.payer||!view.needsPayerAccept||!inbox)throw new Error('Quote expired, already accepted, or private inbox is not ready.')
      assertDeploymentAgreement(config,a)
      await commitAsPayer(row.id)
      payload={...payload,re:view.proposal.id}
    }
    if(action==='payment-report') {
      if(me!==a.payer||!view.funded||view.completed||payload.status==='started'&&!view.canPay)throw new Error('Verified, undisputed funding is required before starting payment.')
      payload={...payload,re:view.notice.id}
    }
    if(action==='escrow-declined') {
      if(me!==a.payer||!view.notice||view.paymentStarted||view.declined)throw new Error('Only unpaid escrow can be declined.')
      payload={...payload,re:view.notice.id}
    }
    if(action==='merchant-confirmed'&&(me!==a.requester||!view.funded||view.completed))throw new Error('Cannot confirm merchant credit at this stage.')
    if(action==='follow-up'&&!view.completed)throw new Error('Follow-up cases are for completed trades.')
    if(['cancel-request','cancel-agree','dispute','evidence'].includes(action)&&(!view.offered||view.completed))throw new Error('This action requires an active accepted trade.')
    const signed=await signer.sign(privateTemplate(row.id.slice(6),action,payload))
    // Delivery is durable and retryable; own intent is saved before sending.
    await vault.write(row.id,{...fresh.value,...own(fresh,signed)},fresh.revision)
    for(const to of [a.requester,a.payer,...(view.dispute?[a.arbitrator]:[])].filter(pk=>pk!==me))await deliverPrivate({client,signer,vault,to,signed})
    await reload()
  }
  const listings=currentListings([...publicEvents.values()],clock)
  const trades=records.filter(r=>r.value.kind==='trade').map(row=>({...row,view:viewOf(row,clock)}))
  const save=async(row,patch)=>vault.write(row.id,{...row.value,...patch},row.revision)
  const sendTrade=async(row,action,payload)=>{
    const a=row.value.agreement,signed=await signer.sign(privateTemplate(row.id.slice(6),action,payload))
    const disputed=viewOf(row).dispute
    const next=await save(row,own(row,signed))
    for(const to of [a.requester,a.payer,...(disputed?[a.arbitrator]:[])].filter(pk=>pk!==signer.pubkey))await deliverPrivate({client,signer,vault,to,signed})
    return next
  }
  // The requester accepts by funding: the notice references the payer's
  // signed commitment, and the saved swap is completed exactly once.
  async function fund(row,token) {
    if(!config.protectedEnabled)throw new Error('Real mint operations are disabled until deployment integration checks pass.')
    row=await vault.read(row.id)
    const a=row.value.agreement,view=viewOf(row)
    if(signer.pubkey!==a.requester)throw new Error('Only the requester funds this agreement.')
    assertDeploymentAgreement(config,a)
    if(row.value.evidence.funding?.verified)throw new Error('Already funded. Retry pending messages instead of funding again.')
    if(!view.offered||!view.canFund&&!row.value.fundingOperation)throw new Error('Funding window closed or the payer has not committed.')
    const latestTrades=(await vault.snapshot()).filter(r=>r.value.kind==='trade').map(r=>{const v=viewOf(r);return {id:r.id.slice(6),agreement:r.value.agreement,view:{...v,occupiesSlot:v.occupiesSlot||!!r.value.fundingOperation&&!v.completed}}})
    requireFreeSlot(a.payer,latestTrades,row.id.slice(6))
    const wallet=await mintFor(a)
    const backup=operation=>backupOperation(vault,signer,operation,fetch,client)
    if(!row.value.fundingOperation) {
      // v4 tokens carry short keyset ids that only the mint's wallet can expand.
      const decoded=wallet.decodeToken(token.trim())
      if(decoded.mint.replace(/\/$/,'')!==a.mint||decoded.unit&&decoded.unit!=='sat')throw new Error('Funding token has the wrong mint or unit.')
      row=await save(row,{fundingOperation:await prepareFunding(wallet,a,decoded.proofs)})
    }
    const result=await completeFunding(wallet,a,row.value.fundingOperation,backup)
    row=await save(row,{proofs:result.send,change:result.keep,evidence:{...row.value.evidence,funding:result.funding}})
    await sendTrade(row,'funding',{proofs:result.send,re:view.acceptance.id})
    await reload()
  }
  // Escrow that arrives late, or after the payer committed elsewhere, is
  // declined with a signed message so both sides agree it is refund-only.
  async function verifyIncomingFunding(row) {
    row=await vault.read(row.id)
    const a=row.value.agreement,view=viewOf(row)
    if(!view.notice)throw new Error('No funding proof has arrived for this agreement.')
    const wallet=await mintFor(a)
    const funding=await verifyFunding(wallet,a,view.notice.payload.proofs)
    row=await save(row,{proofs:view.notice.payload.proofs,evidence:{...row.value.evidence,funding}})
    if(signer.pubkey===a.payer&&!view.declined&&(view.lateNotice||payerCommitted(a.payer,await vault.snapshot(),row.id)))
      await sendTrade(row,'escrow-declined',{re:view.notice.id,reason:view.lateNotice?'Escrow arrived after the funding window.':'Payer had already committed to another trade.'})
    await reload()
  }
  async function proposeResolution(row,allocation) {
    row=await vault.read(row.id)
    const a=row.value.agreement,view=viewOf(row)
    validateResolution(a,view,allocation,signer.pubkey)
    const wallet=await mintFor(a),operation=await prepareResolution(wallet,a,row.value.proofs,allocation)
    row=await save(row,{resolutionOperation:operation})
    await sendTrade(row,'resolution',{operation});await reload()
  }
  async function approveResolution(row,operation) {
    row=await vault.read(row.id)
    const a=row.value.agreement,view=viewOf(row)
    validateResolution(a,view,operation.allocation,signer.pubkey)
    const fingerprint=await resolutionFingerprint(a,row.value.proofs,operation)
    if(row.value.signedResolutionFingerprint&&row.value.signedResolutionFingerprint!==fingerprint)throw new Error('You already signed a different payout. Reconcile it before signing another; signatures cannot be revoked.')
    if(!row.value.escrowKey)throw new Error('Import the agreed arbitrator signing key before approving this case.')
    const signed=await signResolution(a,row.value.proofs,operation,row.value.escrowKey.secret)
    row=await save(row,{resolutionOperation:signed,signedResolutionFingerprint:fingerprint})
    await backupOperation(vault,signer,signed,fetch,client)
    await sendTrade(row,'resolution-approve',{operation:signed});await reload()
  }
  async function settle(row,operation) {
    if(!config.protectedEnabled)throw new Error('Mint settlement is disabled until deployment verification.')
    row=await vault.read(row.id)
    const wallet=await mintFor(row.value.agreement)
    validateResolution(row.value.agreement,viewOf(row),operation.allocation,signer.pubkey)
    const result=await completeResolution(wallet,row.value.agreement,row.value.proofs,operation,op=>backupOperation(vault,signer,op,fetch,client))
    row=await save(row,{payouts:result.payouts,evidence:{...row.value.evidence,redemption:result.redemption}})
    await sendTrade(row,'payout',{operation,payouts:result.payouts});await reload()
  }
  // After the timelock the requester alone returns unresolved escrow to
  // themselves; the mint enforces the locktime, so this cannot pay anyone else.
  async function timelockRefund(row) {
    if(!config.protectedEnabled)throw new Error('Mint settlement is disabled until deployment verification.')
    row=await vault.read(row.id)
    const a=row.value.agreement,view=viewOf(row)
    if(signer.pubkey!==a.requester||!view.refundable)throw new Error('The refund timelock has not passed for this escrow.')
    const wallet=await mintFor(a),fee=Number(wallet.getFeesForProofs(row.value.proofs))
    const allocation={requesterSats:a.escrowSats-fee,payerSats:0,mintFeeSats:fee,reason:'Refund timelock passed without resolution.'}
    const operation=row.value.refundOperation||await signResolution(a,row.value.proofs,await prepareResolution(wallet,a,row.value.proofs,allocation),row.value.escrowKey.secret)
    row=await save(row,{refundOperation:operation})
    const result=await completeResolution(wallet,a,row.value.proofs,operation,op=>backupOperation(vault,signer,op,fetch,client))
    row=await save(row,{payouts:result.payouts,resolutionOperation:operation,evidence:{...row.value.evidence,redemption:result.redemption}})
    await sendTrade(row,'payout',{operation,payouts:result.payouts});await reload()
  }
  async function verifyIncomingPayout(row) {
    row=await vault.read(row.id)
    const a=row.value.agreement,message=row.value.events.map(parsePrivate).filter(e=>e?.action==='payout').at(-1)
    if(!message)throw new Error('No payout receipt has arrived.')
    const wallet=await mintFor(a),{operation,payouts}=message.payload
    const redemption=await verifyPayout(wallet,a,row.value.proofs,operation,payouts)
    await save(row,{payouts,resolutionOperation:operation,evidence:{...row.value.evidence,redemption}});await reload()
  }
  async function collectPayout(row) {
    if(!config.protectedEnabled)throw new Error('Mint operations are disabled.')
    row=await vault.read(row.id)
    if(row.value.claimResult)return getEncodedToken({mint:row.value.agreement.mint,proofs:row.value.claimResult.keep,unit:'sat'})
    const a=row.value.agreement,role=signer.pubkey===a.requester?'requester':signer.pubkey===a.payer?'payer':null
    if(!role||!row.value.evidence.redemption?.verified)throw new Error('Verify your settled payout first.')
    const wallet=await mintFor(a)
    if(!row.value.claimOperation) {
      row=await save(row,{claimOperation:await prepareClaim(wallet,a,row.value.payouts[role],row.value.escrowKey.secret)})
      await reload();throw new Error(`Collection prepared. Mint fee: ${row.value.claimOperation.preview.fees} sats. Click Collect again to confirm this fee.`)
    }
    const result=await completeClaim(wallet,a,row.value.claimOperation,row.value.escrowKey.secret,op=>backupOperation(vault,signer,op,fetch,client))
    await save(row,{claimResult:result});await reload()
    return getEncodedToken({mint:a.mint,proofs:result.keep,unit:'sat'})
  }
  async function escalate(row) {
    row=await vault.read(row.id)
    const a=row.value.agreement,view=viewOf(row)
    if(!view.dispute)throw new Error('Report the dispute before sending a case.')
    const signed=await signer.sign(privateTemplate(row.id.slice(6),'case',{agreement:a,events:row.value.events}))
    await deliverPrivate({client,signer,vault,to:a.arbitrator,signed});await reload()
  }
  async function importArbitratorKey(row,secret) {
    row=await vault.read(row.id)
    const a=row.value.agreement,pubkey=bytesToHex(getPubKeyFromPrivKey(hexToBytes(secret.trim())))
    if(a.arbitrator!==signer.pubkey||pubkey!==a.escrowKeys.arbitrator)throw new Error('Key does not match the agreed arbitrator.')
    await save(row,{escrowKey:{secret:secret.trim(),pubkey}});await reload()
  }
  async function retry() {
    for(const row of await vault.snapshot()) {
      if(row.id.startsWith('outbox:')&&row.value.status==='pending')await deliverPrivate({client,signer,vault,to:row.value.to,signed:row.value.signed})
      if(row.value.kind==='listing'&&row.value.status==='pending') {await client.publish(row.value.signed);await vault.write(row.id,{...row.value,status:'published'},row.revision)}
      if(row.value.kind==='trade')for(const signed of row.value.events.filter(e=>e.pubkey===signer.pubkey)) {
        const a=row.value.agreement
        for(const to of [a.requester,a.payer].filter(pk=>pk!==signer.pubkey)) {
          const pending=await vault.read(`outbox:${signed.id}:${to}`)
          if(pending?.value.status==='delivered')continue
          await deliverPrivate({client,signer,vault,to,signed})
        }
      }
    }
    await reload()
  }
  const exclusive=fn=>(...args)=>{
    if(!navigator.locks)throw new Error('This browser needs Web Locks support for private marketplace operations.')
    return navigator.locks.request(`wot-pay:${signer?.pubkey}:operations`,()=>fn(...args))
  }
  return {client,listings,trades,records,config,supported,inbox,error,vault,reload,enableInbox,publishListing:exclusive(publishListing),requestQuote:exclusive(requestQuote),propose:exclusive(propose),action:exclusive(action),retry:exclusive(retry),fund:exclusive(fund),verifyIncomingFunding:exclusive(verifyIncomingFunding),proposeResolution:exclusive(proposeResolution),approveResolution:exclusive(approveResolution),settle:exclusive(settle),verifyIncomingPayout:exclusive(verifyIncomingPayout),collectPayout:exclusive(collectPayout),escalate:exclusive(escalate),importArbitratorKey:exclusive(importArbitratorKey),timelockRefund:exclusive(timelockRefund)}
}
