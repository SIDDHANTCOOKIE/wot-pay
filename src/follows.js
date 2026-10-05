// Only edits requested p-tags; preserves other people's follows and metadata.
export function mergeFollows(existing, owner, additions = [], removals = []) {
  if (existing && (existing.kind !== 3 || existing.pubkey !== owner))
    throw new Error('Follow-list owner mismatch')
  const valid = (pk) => /^[0-9a-f]{64}$/.test(pk)
  if (![...additions, ...removals].every(valid)) throw new Error('Invalid public key')
  const remove = new Set(removals),
    tags = (existing?.tags || []).filter((t) => !(t[0] === 'p' && remove.has(t[1]))).map((t) => [...t])
  const present = new Set(tags.filter((t) => t[0] === 'p').map((t) => t[1]))
  for (const pk of additions)
    if (!present.has(pk)) {
      tags.push(['p', pk])
      present.add(pk)
    }
  return {
    kind: 3,
    created_at: Math.max(Math.floor(Date.now() / 1000), (existing?.created_at || 0) + 1),
    tags,
    content: existing?.content || '',
  }
}
export function latestFollow(lists, owner) {
  return (
    lists
      .filter((e) => e?.kind === 3 && e.pubkey === owner && Number.isSafeInteger(e.created_at) && Array.isArray(e.tags) && typeof e.id === 'string')
      .filter(e => e.created_at <= Math.floor(Date.now() / 1000) + 60)
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0] || null
  )
}
