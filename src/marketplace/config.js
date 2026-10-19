export function marketplaceConfig(env = import.meta.env) {
  let panel = []
  try { panel = JSON.parse(env.VITE_ARBITRATOR_PANEL || '[]') } catch { /* Invalid config disables agreement creation. */ }
  panel = Array.isArray(panel) ? panel.filter(p => p && /^[0-9a-f]{64}$/.test(p.pubkey) && /^(02|03)[0-9a-f]{64}$/.test(p.escrowKey) && typeof p.name === 'string' && p.name.length <= 80) : []
  const feeRecipient = env.VITE_FEE_RECIPIENT || ''
  const ready=panel.length > 0
  return { panel, feeRecipient, ready, protectedEnabled: ready && env.VITE_PROTECTED_TRADES_ENABLED === 'true' }
}

export function assertDeploymentAgreement(config, agreement) {
  if(!config.ready||(agreement.serviceFeeSats>0&&agreement.feeRecipient!==config.feeRecipient)||!config.panel.some(p=>p.pubkey===agreement.arbitrator&&p.escrowKey===agreement.escrowKeys.arbitrator))throw new Error('Agreement must use the configured independent arbitrator panel and fee recipient.')
}
