// Permanent escrow can outlive a finite retry cache. Until arbitrary-output
// NUT-09 restoration is implemented, a finite cache cannot satisfy recovery.
export function assertSwapRecoveryPolicy(policy) {
  if(!policy?.cached_endpoints?.some(e=>e.method==='POST'&&e.path==='/v1/swap'))throw new Error('Mint must cache POST /v1/swap, not just mint or melt requests.')
  if(policy.ttl!==null)throw new Error('This escrow adapter requires indefinite swap-response retention (NUT-19 ttl: null). Finite retention needs additional restore support.')
}
