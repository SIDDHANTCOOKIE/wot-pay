import { decode, npubEncode } from 'nostr-tools/nip19'

export const DEFAULT_SUPPORT_NPUB = 'npub17cth6et9yp0ejv2gwfxzcjucek7msfpqa5pajlv8r4jkzjaxkkvqapeytq'

export function supportProfile(value) {
  try {
    const parsed=decode(value?.trim()||'')
    return parsed.type==='npub'?`nostr:${npubEncode(parsed.data)}`:null
  }catch{return null}
}

export default function SupportZap({npub=import.meta.env.VITE_SUPPORT_NPUB ?? DEFAULT_SUPPORT_NPUB}) {
  const href=supportProfile(npub)
  if(!href)return null
  return <aside className="card"><strong>Enjoying wot-pay?</strong><p>Trading has no platform fee. Support the product with an optional zap.</p><a className="btn ghost" href={href}>Open our Nostr profile to zap</a><small>Your Nostr app handles the zap. Supporting us does not affect offers, trust ranking or trade settlement.</small></aside>
}
