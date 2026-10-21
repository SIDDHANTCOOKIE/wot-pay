import { httpsOrigin } from './protocol.js'

export function marketplaceConfig(env = import.meta.env) {
  let panel = [], restoreMints = []
  try { panel = JSON.parse(env.VITE_ARBITRATOR_PANEL || '[]') } catch { /* Invalid config disables agreement creation. */ }
  panel = Array.isArray(panel) ? panel.filter(p => p && /^[0-9a-f]{64}$/.test(p.pubkey) && /^(02|03)[0-9a-f]{64}$/.test(p.escrowKey) && typeof p.name === 'string' && p.name.length <= 80) : []
  // Only mints whose lost-response NUT-09 restoration passed a live test.
  try { restoreMints = JSON.parse(env.VITE_RESTORE_VERIFIED_MINTS || '[]') } catch { /* Invalid config disables restore-only mints. */ }
  restoreMints = Array.isArray(restoreMints) ? restoreMints.filter(m => { try { return httpsOrigin(m) === m } catch { return false } }) : []
  const ready=panel.length > 0
  return { panel, restoreMints, ready, protectedEnabled: ready && env.VITE_PROTECTED_TRADES_ENABLED === 'true' }
}

export function assertDeploymentAgreement(config, agreement) {
  if(!config.ready||!config.panel.some(p=>p.pubkey===agreement.arbitrator&&p.escrowKey===agreement.escrowKeys.arbitrator))throw new Error('Agreement must use the configured independent arbitrator panel.')
}
