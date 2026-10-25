import { createElement } from 'react'
import { expect,it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { generateSecretKey,getPublicKey } from 'nostr-tools/pure'
import { npubEncode } from 'nostr-tools/nip19'
import SupportZap,{supportProfile,DEFAULT_SUPPORT_NPUB} from './SupportZap.jsx'

it('uses the project owner’s verified public support profile by default',()=>{
  const html=renderToStaticMarkup(createElement(SupportZap))
  expect(html).toContain(`href="nostr:${DEFAULT_SUPPORT_NPUB}"`)
})

it('offers optional profile-based support only for a valid configured npub',()=>{
  expect(renderToStaticMarkup(createElement(SupportZap,{npub:''}))).toBe('')
  expect(supportProfile('javascript:alert(1)')).toBeNull()
  const npub=npubEncode(getPublicKey(generateSecretKey()))
  const html=renderToStaticMarkup(createElement(SupportZap,{npub}))
  expect(html).toContain(`nostr:${npub}`)
  expect(html).toContain('optional zap')
  expect(html).toContain('support-link')
  expect(html).not.toContain('<aside')
  expect(html).toContain('Generate Lightning invoice')
})
