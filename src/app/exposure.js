// A reminder based on viewer-relative signed claims, never a safety verdict.
export function exposureWarning(trust, loading = false) {
  if (loading || trust?.settles > 0) return null
  return 'Start small. No settled trade claims found in your web; a follow is not payment proof.'
}
