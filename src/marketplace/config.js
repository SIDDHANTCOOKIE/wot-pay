import { httpsOrigin } from './protocol.js'

export function marketplaceConfig(env = import.meta.env) {
  let panel = [], restoreMints = []
  try { panel = JSON.parse(env.VITE_ARBITRATOR_PANEL || '[]') } catch { /* Invalid config disables agreement creation. */ }
  panel = Array.isArray(panel) ? panel.filter(p => p && /^[0-9a-f]{64}$/.test(p.pubkey) && /^(02|03)[0-9a-f]{64}$/.test(p.escrowKey) && typeof p.name === 'string' && p.name.length <= 80) : []
  // Only mints whose lost-response NUT-09 restoration passed a live test.
  try { restoreMints = JSON.parse(env.VITE_RESTORE_VERIFIED_MINTS || '[]') } catch { /* Invalid config disables restore-only mints. */ }
  restoreMints = Array.isArray(restoreMints) ? restoreMints.filter(m => { try { return httpsOrigin(m) === m } catch { return false } }) : []
  // Pilot limits in whole rupees. No limit is implied: trading stays disabled
  // until both are set, with the daily limit at least the per-trade one.
  const rupees = name => { const v = Number(env[name]); return Number.isSafeInteger(v) && v > 0 ? v * 100 : null }
  const limits = { tradePaise: rupees('VITE_PILOT_MAX_INR_PER_TRADE'), dayPaise: rupees('VITE_PILOT_MAX_INR_PER_DAY') }
  const limited = !!limits.tradePaise && !!limits.dayPaise && limits.tradePaise <= limits.dayPaise
  const ready=panel.length > 0
  return { panel, restoreMints, limits, ready, protectedEnabled: ready && limited && env.VITE_PROTECTED_TRADES_ENABLED === 'true' }
}

export function assertWithinLimits(config, paise, recentPaise = 0) {
  const { tradePaise, dayPaise } = config.limits || {}
  if (!tradePaise || !dayPaise) throw new Error('Pilot trade limits are not configured.')
  if (paise > tradePaise) throw new Error(`The pilot limit is ₹${tradePaise / 100} per trade.`)
  if (recentPaise + paise > dayPaise) throw new Error(`The pilot limit is ₹${dayPaise / 100} per day across your trades.`)
}

export function assertDeploymentAgreement(config, agreement) {
  if(!config.ready||!config.panel.some(p=>p.pubkey===agreement.arbitrator&&p.escrowKey===agreement.escrowKeys.arbitrator))throw new Error('Agreement must use the configured independent arbitrator panel.')
}
