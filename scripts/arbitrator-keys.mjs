import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { bytesToHex } from 'nostr-tools/utils'
import { childPubkeys, findChildSecret } from '../src/marketplace/arbitrator-keys.js'

// Run on the arbitrator's offline device. The seed never goes into the app,
// the deployment or a browser: only public keys are published, and a single
// trade's secret is derived when that trade's case needs a signature.
const usage = `Usage:
  npm run arbitrator:keys -- generate <seed-file> [count]   create a seed file and print public keys for the panel
  npm run arbitrator:keys -- list <seed-file> [count]       print the public keys again
  npm run arbitrator:keys -- derive <seed-file> <escrow-key> print one trade's secret to paste into its case`
const readSeed = file => {
  const seed = readFileSync(file, 'utf8').trim()
  if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error('The seed file must hold 64 lowercase hex characters.')
  return seed
}
const count = value => {
  const n = Number(value ?? 64)
  if (!Number.isSafeInteger(n) || n < 1 || n > 1024) throw new Error('Count must be between 1 and 1024.')
  return n
}
try {
  const [command, file, arg] = process.argv.slice(2)
  if (!file) throw new Error(usage)
  if (command === 'generate') {
    if (existsSync(file)) throw new Error('Refusing to overwrite an existing seed file.')
    writeFileSync(file, bytesToHex(crypto.getRandomValues(new Uint8Array(32))) + '\n', { mode: 0o600, flag: 'wx' })
    console.error(`Seed written to ${file}. Keep it offline and backed up; losing it loses arbitration over every trade using these keys.`)
    console.log(JSON.stringify({ escrowKeys: await childPubkeys(readSeed(file), count(arg)) }))
  } else if (command === 'list') {
    console.log(JSON.stringify({ escrowKeys: await childPubkeys(readSeed(file), count(arg)) }))
  } else if (command === 'derive') {
    if (!/^(02|03)[0-9a-f]{64}$/.test(arg || '')) throw new Error('Pass the trade\'s arbitrator escrow key (66 hex characters).')
    const { index, secret } = await findChildSecret(readSeed(file), arg)
    console.error(`Key #${index}. Paste it into this case only, then clear your clipboard.`)
    console.log(secret)
  } else throw new Error(usage)
} catch (e) { console.error(e.message); process.exitCode = 1 }
