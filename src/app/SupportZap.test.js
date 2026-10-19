import { createElement } from 'react'
import { expect,it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { generateSecretKey,getPublicKey } from 'nostr-tools/pure'
import { npubEncode } from 'nostr-tools/nip19'
import SupportZap,{supportProfile} from './SupportZap.jsx'

it('offers optional profile-based support only for a valid configured npub',()=>{
  expect(renderToStaticMarkup(createElement(SupportZap,{npub:''}))).toBe('')
  expect(supportProfile('javascript:alert(1)')).toBeNull()
  const npub=npubEncode(getPublicKey(generateSecretKey()))
  const html=renderToStaticMarkup(createElement(SupportZap,{npub}))
  expect(html).toContain(`nostr:${npub}`)
  expect(html).toContain('optional zap')
  expect(html).toContain('does not affect offers')
})
