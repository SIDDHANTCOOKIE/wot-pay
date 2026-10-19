import { expect,it } from 'vitest'
import { assertSwapRecoveryPolicy } from './mint-policy.js'
it('rejects caching only unrelated endpoints and finite or omitted retention',()=>{
  expect(()=>assertSwapRecoveryPolicy({ttl:null,cached_endpoints:[{method:'POST',path:'/v1/mint/bolt11'}]})).toThrow('swap')
  for(const ttl of [undefined,0,3600])expect(()=>assertSwapRecoveryPolicy({ttl,cached_endpoints:[{method:'POST',path:'/v1/swap'}]})).toThrow('retention')
  expect(()=>assertSwapRecoveryPolicy({ttl:null,cached_endpoints:[{method:'POST',path:'/v1/swap'}]})).not.toThrow()
})
