import { bech32 } from '@scure/base'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { finalizeEvent, generateSecretKey, verifyEvent } from 'nostr-tools/pure'
import { bytesToHex } from 'nostr-tools/utils'
import { digest } from './recovery.js'

const utf8=new TextEncoder(),text=new TextDecoder()
const number=words=>words.reduce((n,w)=>n*32+w,0)
const hex=words=>bytesToHex(bech32.fromWords(words))
function paddedBytes(words) {
  const out=[];let buffer=0,bits=0
  for(const w of words){buffer=(buffer<<5)|w;bits+=5;while(bits>=8){bits-=8;out.push((buffer>>>bits)&255)}buffer&=(1<<bits)-1}
  if(bits)out.push((buffer<<(8-bits))&255)
  return new Uint8Array(out)
}
export function publicHttps(value) {
  const u=new URL(value),host=u.hostname.toLowerCase()
  if(u.protocol!=='https:'||u.username||u.password||u.hash||!host.includes('.')||host.endsWith('.local')||host.endsWith('.internal')||host.endsWith('.localhost')||host.includes(':')||/^[\d.]+$/.test(host))throw new Error('The Lightning provider must use a public HTTPS address.')
  return u
}
export function lightningEndpoint(events,recipient,now=Math.floor(Date.now()/1000)) {
  const latest=events.filter(e=>{try{return e.kind===0&&e.pubkey===recipient&&e.created_at<=now+60&&e.content.length<=32000&&verifyEvent(JSON.parse(JSON.stringify(e)))}catch{return false}}).sort((a,b)=>b.created_at-a.created_at||a.id.localeCompare(b.id))[0]
  if(!latest)throw new Error('Could not load the support profile. Check the relay connection and retry.')
  const profile=JSON.parse(latest.content)
  if(typeof profile.lud16==='string'&&/^[^\s/@]+@[^\s/@]+$/.test(profile.lud16)) {
    const [user,host]=profile.lud16.split('@')
    return publicHttps(`https://${host}/.well-known/lnurlp/${encodeURIComponent(user)}`).href
  }
  if(typeof profile.lud06==='string') {
    const decoded=bech32.decode(profile.lud06,4096)
    if(decoded.prefix!=='lnurl')throw new Error('Invalid Lightning address in the support profile.')
    return publicHttps(text.decode(bech32.fromWords(decoded.words))).href
  }
  throw new Error('The support profile has no Lightning receiving address. Its owner needs to add one before zaps can work.')
}
async function json(url,fetcher) {
  const href=publicHttps(url).href
  let response
  try {response=await fetcher(href,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000),cache:'no-store'})}
  catch {throw new Error('Could not reach the Lightning provider. Check your connection and try again.')}
  if(!response.ok)throw new Error('Lightning provider is unavailable. Try again later.')
  const reader=response.body?.getReader()
  if(!reader)throw new Error('Lightning provider returned an empty response.')
  const chunks=[];let size=0
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>64000){await reader.cancel();throw new Error('Lightning provider response is too large.')}chunks.push(value)}
  const bytes=new Uint8Array(size);let offset=0
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
  const body=text.decode(bytes)
  const data=JSON.parse(body)
  if(data.status==='ERROR')throw new Error('The Lightning provider rejected the invoice request.')
  return data
}
export async function verifyZapInvoice(invoice,msats,description,now=Math.floor(Date.now()/1000)) {
  if(typeof invoice!=='string'||invoice.length>10000)throw new Error('Invalid Lightning invoice.')
  const decoded=bech32.decode(invoice,10000),match=/^lnbc(\d+)([munp]?)$/.exec(decoded.prefix)
  if(!match)throw new Error('Expected a Bitcoin mainnet invoice with an amount.')
  const n=BigInt(match[1]),unit=match[2],multipliers={'':100000000000n,m:100000000n,u:100000n,n:100n}
  const value=unit==='p'?n/10n:n*multipliers[unit]
  if(unit==='p'&&n%10n||value!==BigInt(msats))throw new Error('Invoice amount differs from the selected zap.')
  const words=decoded.words
  if(words.length<111)throw new Error('Truncated Lightning invoice.')
  const end=words.length-104,timestamp=number(words.slice(0,7)),fields=new Map()
  for(let i=7;i<end;) {
    if(i+3>end)throw new Error('Malformed invoice field.')
    const type=words[i],length=number(words.slice(i+1,i+3));i+=3
    if(i+length>end)throw new Error('Truncated invoice field.')
    if([1,6,13,19,23].includes(type)&&fields.has(type))throw new Error('Duplicate invoice field.')
    fields.set(type,words.slice(i,i+length));i+=length
  }
  const expiry=fields.has(6)?number(fields.get(6)):3600
  if(!Number.isSafeInteger(expiry)||timestamp>now+60||timestamp+expiry<=now)throw new Error('Invoice has expired or has an invalid timestamp.')
  if(fields.has(13)||!fields.has(23)||hex(fields.get(23))!==await digest(utf8.encode(description))||!fields.has(1)||fields.get(1).length!==52)throw new Error('Invoice is not bound to this zap request.')
  const signature=bech32.fromWords(words.slice(end))
  if(signature.length!==65||signature[64]>3)throw new Error('Invalid invoice signature.')
  const preimage=new Uint8Array([...utf8.encode(decoded.prefix),...paddedBytes(words.slice(0,end))])
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',preimage))
  const recovered=secp256k1.recoverPublicKey(new Uint8Array([signature[64],...signature.slice(0,64)]),hash,{prehash:false})
  if(!secp256k1.verify(signature.slice(0,64),hash,recovered,{prehash:false,lowS:false})||fields.has(19)&&hex(fields.get(19))!==bytesToHex(recovered))throw new Error('Invoice signature does not match its payee.')
  return {invoice:invoice.toLowerCase(),expiresAt:timestamp+expiry,paymentHash:hex(fields.get(1))}
}
export async function createSupportInvoice({client,recipient,sats,lightningAddress,fetcher=fetch,now=Math.floor(Date.now()/1000)}) {
  if(!/^[1-9]\d{0,8}$/.test(String(sats)))throw new Error('Enter a positive whole-sat amount.')
  const msats=Number(sats)*1000
  let endpoint
  if(lightningAddress) {
    if(!/^[^\s/@]+@[^\s/@]+$/.test(lightningAddress))throw new Error('Invalid support Lightning address.')
    const [user,host]=lightningAddress.split('@')
    endpoint=publicHttps(`https://${host}/.well-known/lnurlp/${encodeURIComponent(user)}`).href
  } else endpoint=lightningEndpoint(await client.queryIdentity({kinds:[0],authors:[recipient]},{discover:true}),recipient,now)
  const provider=await json(endpoint,fetcher)
  if(provider.tag!=='payRequest'||provider.allowsNostr!==true||!/^[0-9a-f]{64}$/.test(provider.nostrPubkey))throw new Error('The receiving wallet does not support Nostr zaps.')
  secp256k1.Point.fromHex(`02${provider.nostrPubkey}`)
  if(!Number.isSafeInteger(provider.minSendable)||!Number.isSafeInteger(provider.maxSendable)||provider.minSendable<1||provider.maxSendable<provider.minSendable)throw new Error('The support wallet cannot receive payments right now. Its owner needs to enable Lightning receiving with their wallet provider.')
  if(msats<provider.minSendable||msats>provider.maxSendable)throw new Error(`Choose between ${Math.ceil(provider.minSendable/1000)} and ${Math.floor(provider.maxSendable/1000)} sats for this wallet.`)
  const relays=client.relays.filter(r=>{try{return new URL(r).protocol==='wss:'}catch{return false}})
  if(!relays.length)throw new Error('A secure receipt relay is required.')
  const lnurl=bech32.encode('lnurl',bech32.toWords(utf8.encode(endpoint)),4096)
  // A fresh disposable identity keeps support independent of sign-in/trading.
  const request=finalizeEvent({kind:9734,created_at:now,content:'',tags:[['p',recipient],['amount',String(msats)],['relays',...relays],['lnurl',lnurl]]},generateSecretKey())
  const description=JSON.stringify(request),callback=publicHttps(provider.callback)
  callback.searchParams.set('amount',String(msats));callback.searchParams.set('nostr',description);callback.searchParams.set('lnurl',lnurl)
  const result=await json(callback.href,fetcher)
  return {...await verifyZapInvoice(result.pr,msats,description,now),request,providerPubkey:provider.nostrPubkey,recipient,sats:Number(sats)}
}

export function validZapReceipt(event,zap) {
  try {
    if(event.kind!==9735||event.pubkey!==zap.providerPubkey||event.created_at<zap.request.created_at-60||event.created_at>Math.floor(Date.now()/1000)+60||!verifyEvent(JSON.parse(JSON.stringify(event))))return false
    const tag=name=>{const values=event.tags.filter(t=>t[0]===name);return values.length===1?values[0][1]:null}
    return tag('p')===zap.recipient&&tag('bolt11')?.toLowerCase()===zap.invoice&&tag('description')===JSON.stringify(zap.request)
  }catch{return false}
}
