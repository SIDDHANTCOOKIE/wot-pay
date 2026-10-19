import { Wallet } from '@cashu/cashu-ts'
import { assertSwapRecoveryPolicy } from '../src/marketplace/mint-policy.js'

// Read-only: no tokens, keys or monetary endpoints are used.
try {
  const url=new URL(process.argv[2])
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('Usage: npm run check:mint -- https://mint-host/path')
  const wallet=new Wallet(url.toString().replace(/\/$/,''))
  await wallet.loadMint()
  const info=wallet.getMintInfo()
  for(const n of [7,11,12,19])if(!info.isSupported(n).supported)throw new Error(`NUT-${n} is missing.`)
  assertSwapRecoveryPolicy(info.isSupported(19).params)
  if(wallet.unit!=='sat')throw new Error('Expected sat unit.')
  console.log('Mint metadata and key loading passed. Still required: controlled funding/release/refund, lost-response recovery, browser CORS and operator availability tests. No funds moved.')
}catch(e){console.error(`Mint check failed: ${e.message}`);process.exitCode=1}
