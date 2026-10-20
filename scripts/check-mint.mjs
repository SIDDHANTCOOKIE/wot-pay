import { Wallet } from '@cashu/cashu-ts'
import { assertSwapRecoveryPolicy } from '../src/marketplace/mint-policy.js'

// Read-only: no tokens, keys or monetary endpoints are used.
try {
  const url=new URL(process.argv[2])
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('Usage: npm run check:mint -- https://mint-host/path')
  const wallet=new Wallet(url.toString().replace(/\/$/,''))
  await wallet.loadMint()
  const info=wallet.getMintInfo()
  for(const n of [7,11,12])if(!info.isSupported(n).supported)throw new Error(`NUT-${n} is missing.`)
  if(wallet.unit!=='sat')throw new Error('Expected sat unit.')
  const restore=info.isSupported(9).supported
  // Metadata cannot prove restoration works, so treat it as a candidate only.
  const mode=assertSwapRecoveryPolicy(info.isSupported(19),{supported:restore,verified:restore})
  console.log(mode==='cache'
    ?'Mint metadata passed: indefinite NUT-19 swap cache.'
    :'Mint metadata passed as a NUT-09 restore candidate only. Add it to VITE_RESTORE_VERIFIED_MINTS only after a controlled lost-response restore test.')
  console.log(`NUT-09 restore advertised: ${restore?'yes':'no'}. Still required: controlled funding/release/refund, lost-response recovery, browser CORS and operator availability tests. No funds moved.`)
}catch(e){console.error(`Mint check failed: ${e.message}`);process.exitCode=1}
