import { expect,it } from 'vitest'
import { marketplaceConfig,assertDeploymentAgreement,assertWithinLimits } from './config.js'
import { testTrade } from './fixtures.js'

it('rejects peer substitution of the arbitrator key',async()=>{
  const {agreement:a}=await testTrade()
  const config=marketplaceConfig({VITE_ARBITRATOR_PANEL:JSON.stringify([{name:'Panel',pubkey:a.arbitrator,escrowKey:a.escrowKeys.arbitrator}])})
  expect(()=>assertDeploymentAgreement(config,a)).not.toThrow()
  expect(()=>assertDeploymentAgreement(config,{...a,escrowKeys:{...a.escrowKeys,arbitrator:a.escrowKeys.payer}})).toThrow('configured')
  expect(config.protectedEnabled).toBe(false)
})
it('fails closed with an incomplete deployment even when the enable flag is set',()=>{
  expect(marketplaceConfig({VITE_ARBITRATOR_PANEL:'[null]',VITE_PROTECTED_TRADES_ENABLED:'true'}).protectedEnabled).toBe(false)
})
it('keeps protected trading off until both pilot limits are published, and enforces them',()=>{
  const base={VITE_ARBITRATOR_PANEL:JSON.stringify([{name:'Panel',pubkey:'a'.repeat(64),escrowKey:'02'+'b'.repeat(64)}]),VITE_PROTECTED_TRADES_ENABLED:'true'}
  for(const limits of [{},{VITE_PILOT_MAX_INR_PER_TRADE:'500'},{VITE_PILOT_MAX_INR_PER_TRADE:'500',VITE_PILOT_MAX_INR_PER_DAY:'400'},{VITE_PILOT_MAX_INR_PER_TRADE:'0.5',VITE_PILOT_MAX_INR_PER_DAY:'1000'}])
    expect(marketplaceConfig({...base,...limits}).protectedEnabled).toBe(false)
  const config=marketplaceConfig({...base,VITE_PILOT_MAX_INR_PER_TRADE:'500',VITE_PILOT_MAX_INR_PER_DAY:'1000'})
  expect(config.protectedEnabled).toBe(true)
  expect(()=>assertWithinLimits(config,50000,50000)).not.toThrow()
  expect(()=>assertWithinLimits(config,50001)).toThrow('per trade')
  expect(()=>assertWithinLimits(config,30000,80000)).toThrow('per day')
  expect(()=>assertWithinLimits(marketplaceConfig(base),100)).toThrow('not configured')
})
