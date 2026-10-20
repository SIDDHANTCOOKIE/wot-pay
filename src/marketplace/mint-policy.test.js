import { expect,it } from 'vitest'
import { assertSwapRecoveryPolicy } from './mint-policy.js'
const nut19=(ttl,path='/v1/swap')=>({supported:true,params:{ttl,cached_endpoints:[{method:'POST',path}]}})
it('rejects caching only unrelated endpoints and finite or omitted retention',()=>{
  expect(()=>assertSwapRecoveryPolicy(nut19(null,'/v1/mint/bolt11'))).toThrow('swap')
  for(const ttl of [undefined,0,3600])expect(()=>assertSwapRecoveryPolicy(nut19(ttl))).toThrow('retention')
  expect(assertSwapRecoveryPolicy(nut19(null))).toBe('cache')
  expect(()=>assertSwapRecoveryPolicy({supported:false})).toThrow('swap')
})
it('accepts finite or absent caching only with NUT-09 restore verified for that mint',()=>{
  for(const n of [nut19(3600),{supported:false}]) {
    expect(()=>assertSwapRecoveryPolicy(n,{supported:true,verified:false})).toThrow('not been verified')
    expect(()=>assertSwapRecoveryPolicy(n,{supported:false,verified:true})).toThrow()
    expect(assertSwapRecoveryPolicy(n,{supported:true,verified:true})).toBe('restore')
  }
})
