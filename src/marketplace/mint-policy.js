// Permanent escrow can outlive a finite retry cache. A lost swap response is
// recoverable either from an indefinite NUT-19 swap cache, or by NUT-09
// restoration of the saved outputs. Advertised NUT-09 is necessary but not
// proof, so restoration counts only for mints verified with a live test.
// Takes MintInfo.isSupported(19) and returns which mechanism recovers a lost response.
export function assertSwapRecoveryPolicy(nut19, restore = {}) {
  const policy = nut19?.supported ? nut19.params : null
  const cachesSwap = !!policy?.cached_endpoints?.some(e => e.method === 'POST' && e.path === '/v1/swap')
  if (cachesSwap && policy.ttl === null) return 'cache'
  if (restore.supported && restore.verified) return 'restore'
  if (restore.supported) throw new Error('Mint advertises NUT-09 restore, but lost-response restoration has not been verified for this mint. Without that, it must cache POST /v1/swap indefinitely (NUT-19 ttl: null).')
  if (!cachesSwap) throw new Error('Mint must cache POST /v1/swap, not just mint or melt requests, or support verified NUT-09 restore.')
  throw new Error('Mint swap-response retention is finite (NUT-19 ttl is not null) and NUT-09 restore is unavailable.')
}
