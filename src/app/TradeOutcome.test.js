import {it,expect} from 'vitest'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import TradeOutcome from './TradeOutcome.jsx'
it('shows dispute even when the viewer stamped settled',()=>{
 const h=renderToStaticMarkup(createElement(TradeOutcome,{state:{status:'disputed'},ownStamp:{type:'settled'}}))
 expect(h).toContain('card done disputed');expect(h).toContain('Disputed.');expect(h).toContain('Do not treat this trade as settled');expect(h).not.toContain('You stamped settled.')
})
it('distinguishes two-party and one-party settlement statements',()=>{
 const render=status=>renderToStaticMarkup(createElement(TradeOutcome,{state:{status},ownStamp:{type:'settled'}}))
 expect(render('settled')).toContain('Settled.');expect(render('stamped')).toContain('You stamped settled.')
})
