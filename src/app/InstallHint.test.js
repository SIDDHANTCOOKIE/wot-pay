import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
vi.mock('./install.js', () => ({ installController: { get: () => ({ installed: false, popup: false }), subscribe: () => () => {} } }))
import InstallHint from './InstallHint.jsx'

describe('install hint visibility', () => {
  it('does not render any install controls while a profile sheet is open', () => {
    expect(renderToStaticMarkup(createElement(InstallHint, { hidden: true }))).toBe('')
  })
  it('keeps the install action available when the sheet is closed', () => {
    expect(renderToStaticMarkup(createElement(InstallHint))).toContain('Install app')
  })
})
