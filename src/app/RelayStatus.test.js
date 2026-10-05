import { it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import RelayStatus from './RelayStatus.jsx'
it('separates relay reachability, use and local signing status',()=>{
 const html=renderToStaticMarkup(createElement(RelayStatus,{signer:{kind:'local'},states:[{url:'wss://trade.example',connected:false,write:true},{url:'wss://profile.example',connected:true,write:false}],onClose:()=>{}}))
 expect(html).toContain('role="dialog"');expect(html).toContain('Down');expect(html).toContain('Up');expect(html).toContain('Trading · read and publish');expect(html).toContain('Profile / follows · read only');expect(html).toContain('no signer relay')
})
