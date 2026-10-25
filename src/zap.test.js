import { expect,it } from 'vitest'
import { bech32 } from '@scure/base'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { finalizeEvent,generateSecretKey,getPublicKey,verifyEvent } from 'nostr-tools/pure'
import { createSupportInvoice,verifyZapInvoice,lightningEndpoint,validZapReceipt,publicHttps } from './zap.js'

const now=Math.floor(Date.now()/1000),key=generateSecretKey(),recipient=getPublicKey(key)
const sha=async bytes=>new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))
const words=n=>{const result=[];do{result.unshift(n%32);n=Math.floor(n/32)}while(n);return result}
const field=(tag,data)=>[tag,Math.floor(data.length/32),data.length%32,...data]
function padded(data){let b=0,n=0;const out=[];for(const w of data){b=(b<<5)|w;n+=5;while(n>=8){n-=8;out.push((b>>>n)&255)}b&=(1<<n)-1}if(n)out.push(b<<(8-n));return out}
async function invoice(msats,description,at=now) {
  const prefix=`lnbc${BigInt(msats)*10n}p`,timestamp=words(at)
  while(timestamp.length<7)timestamp.unshift(0)
  const data=[...timestamp,...field(19,bech32.toWords(secp256k1.getPublicKey(key))),...field(1,bech32.toWords(new Uint8Array(32).fill(7))),...field(23,bech32.toWords(await sha(new TextEncoder().encode(description))))]
  const hash=await sha(new Uint8Array([...new TextEncoder().encode(prefix),...padded(data)]))
  const signature=secp256k1.sign(hash,key,{prehash:false,format:'recovered'})
  return bech32.encode(prefix,[...data,...bech32.toWords(new Uint8Array([...signature.slice(1),signature[0]]))],10000)
}
const profile=content=>finalizeEvent({kind:0,created_at:now,content:JSON.stringify(content),tags:[]},key)
const provider={tag:'payRequest',allowsNostr:true,nostrPubkey:recipient,minSendable:1000,maxSendable:10000000,callback:'https://wallet.example/callback'}

it('generates a guest zap invoice bound to the requested amount and signed request, without publishing or paying',async()=>{
  const requests=[]
  const client={relays:['wss://relay.example'],queryIdentity:async()=>[profile({lud16:'owner@wallet.example'})]}
  const fetcher=async url=>{
    const parsed=new URL(url);requests.push(parsed)
    if(parsed.pathname.startsWith('/.well-known'))return new Response(JSON.stringify(provider))
    const description=parsed.searchParams.get('nostr')
    const event=JSON.parse(description)
    expect(event.kind).toBe(9734);expect(verifyEvent(event)).toBe(true);expect(event.pubkey).not.toBe(recipient)
    expect(event.tags.find(t=>t[0]==='p')[1]).toBe(recipient)
    return new Response(JSON.stringify({pr:await invoice(parsed.searchParams.get('amount'),description)}))
  }
  const zap=await createSupportInvoice({client,recipient,sats:'100',fetcher,now})
  expect(zap.sats).toBe(100);expect(zap.expiresAt).toBe(now+3600);expect(requests.length).toBe(2)
  const receipt=finalizeEvent({kind:9735,created_at:now,content:'',tags:[['p',recipient],['bolt11',zap.invoice],['description',JSON.stringify(zap.request)]]},key)
  expect(validZapReceipt(receipt,zap)).toBe(true)
  expect(validZapReceipt(receipt,{...zap,providerPubkey:getPublicKey(generateSecretKey())})).toBe(false)
  expect(validZapReceipt(receipt,{...zap,invoice:'different'})).toBe(false)
})
it('rejects zero-limit wallets before requesting an invoice and supports a configured address without relay metadata',async()=>{
  let calls=0
  await expect(createSupportInvoice({client:{relays:[],queryIdentity:async()=>{throw Error('should not query')}},recipient,sats:100,lightningAddress:'owner@wallet.example',fetcher:async()=>{calls++;return new Response(JSON.stringify({...provider,maxSendable:0}))}})).rejects.toThrow('enable Lightning receiving')
  expect(calls).toBe(1)
})
it('rejects invoice amount substitution, wrong description commitment, expiry and invalid signatures',async()=>{
  await expect(verifyZapInvoice(await invoice(100000,'request'),200000,'request',now)).rejects.toThrow('amount')
  await expect(verifyZapInvoice(await invoice(100000,'wrong'),100000,'request',now)).rejects.toThrow('bound')
  await expect(verifyZapInvoice(await invoice(100000,'request',now-4000),100000,'request',now)).rejects.toThrow('expired')
  const valid=bech32.decode(await invoice(100000,'request'),10000)
  valid.words[valid.words.length-10]^=1
  await expect(verifyZapInvoice(bech32.encode(valid.prefix,valid.words,10000),100000,'request',now)).rejects.toThrow()
})
it('validates signed profile ownership, reports missing addresses and rejects private or non-HTTPS endpoints',()=>{
  expect(()=>lightningEndpoint([profile({lud16:'owner@wallet.example'})],'0'.repeat(64),now)).toThrow('profile')
  expect(()=>lightningEndpoint([profile({})],recipient,now)).toThrow('no Lightning')
  for(const value of ['http://wallet.example','https://127.0.0.1','https://host.local','https://user:password@wallet.example'])expect(()=>publicHttps(value)).toThrow()
})
