import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
vi.mock('./identity.js', () => ({ hasLocalKey: () => false }))
vi.mock('./SigningSettings.jsx', () => ({ default: () => createElement('div', null, 'Existing signer options') }))
import IdentityChoice from './IdentityChoice.jsx'
it('keeps existing signer options collapsed and guest browsing available', () => {
  const html = renderToStaticMarkup(createElement(IdentityChoice, { onSigner: () => {}, onGuest: () => {} }))
  expect(html).toContain('Create a new key')
  expect(html).toContain('Explore as guest')
  expect(html).toContain('<details')
  expect(html).not.toContain('<details open')
})
