import { expect,it } from 'vitest'
import { OutputData } from '@cashu/cashu-ts'
import { testTrade } from './fixtures.js'
import { testMint } from './test-mint.fixture.js'
import { TERMS_VERSION } from './pricing.js'
import { validateAgreement,contentHash } from './protocol.js'
import { marketplaceConfig,assertDeploymentAgreement } from './config.js'
import { prepareFunding,completeFunding,verifyFunding } from './escrow.js'

it('funds and verifies a new trade without a platform recipient or fee transfer',async()=>{
  const fixture=await testTrade()
  const a=validateAgreement({...fixture.agreement,termsVersion:TERMS_VERSION,serviceFeeSats:0,feeRecipient:null})
  const config=marketplaceConfig({VITE_ARBITRATOR_PANEL:JSON.stringify([{name:'Panel',pubkey:a.arbitrator,escrowKey:a.escrowKeys.arbitrator}]),VITE_PROTECTED_TRADES_ENABLED:'true'})
  expect(config.protectedEnabled).toBe(true)
  expect(()=>assertDeploymentAgreement(config,a)).not.toThrow()
  expect(()=>validateAgreement({...a,serviceFeeSats:10})).toThrow()
  const wallet=testMint(a),input=wallet.issue(OutputData.createRandomData(a.escrowSats,wallet.getKeyset()))
  const op=await prepareFunding(wallet,a,input)
  const result=await completeFunding(wallet,a,op,async operation=>({operationHash:await contentHash(operation),verifiedCopies:2,checkedAt:Date.now(),results:[{server:'https://a.example',verified:true},{server:'https://b.example',verified:true}]}))
  expect(result.send.reduce((sum,p)=>sum+p.amount,0)).toBe(a.escrowSats)
  expect((await verifyFunding(wallet,a,result.send)).verified).toBe(true)
})
