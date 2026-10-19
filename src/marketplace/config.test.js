import { expect,it } from 'vitest'
import { marketplaceConfig,assertDeploymentAgreement } from './config.js'
import { testTrade } from './fixtures.js'

it('rejects peer substitution of the arbitrator key or fee recipient',async()=>{
  const {agreement:a}=await testTrade()
  const config=marketplaceConfig({VITE_ARBITRATOR_PANEL:JSON.stringify([{name:'Panel',pubkey:a.arbitrator,escrowKey:a.escrowKeys.arbitrator}]),VITE_FEE_RECIPIENT:a.feeRecipient})
  expect(()=>assertDeploymentAgreement(config,a)).not.toThrow()
  expect(()=>assertDeploymentAgreement(config,{...a,feeRecipient:a.payer})).toThrow('configured')
  expect(()=>assertDeploymentAgreement(config,{...a,escrowKeys:{...a.escrowKeys,arbitrator:a.escrowKeys.payer}})).toThrow('configured')
  expect(config.protectedEnabled).toBe(false)
})
it('fails closed with an incomplete deployment even when the enable flag is set',()=>{
  expect(marketplaceConfig({VITE_ARBITRATOR_PANEL:'[null]',VITE_PROTECTED_TRADES_ENABLED:'true'}).protectedEnabled).toBe(false)
})
