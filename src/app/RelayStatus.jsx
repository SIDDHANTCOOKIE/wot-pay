import './relay-status.css'
import { useEffect, useRef, useId } from 'react'
export default function RelayStatus({states, signer, onClose}) {
 const ref=useRef(null), id=useId()
 useEffect(()=>{const previous=document.activeElement, overflow=document.body.style.overflow;document.body.style.overflow='hidden';ref.current?.querySelector('button')?.focus();return()=>{document.body.style.overflow=overflow;previous?.isConnected&&previous.focus()}},[])
 return <div className="sheet-bg" onClick={onClose}><section ref={ref} className="sheet relay-sheet" role="dialog" aria-modal="true" aria-labelledby={id} onClick={e=>e.stopPropagation()} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();onClose()}if(e.key==='Tab'){e.preventDefault();ref.current.querySelector('button').focus()}}}>
 <div className="row"><h2 id={id}>Relay connections</h2><button className="btn ghost small" onClick={onClose}>Back</button></div>
 <p className="dim">Signed in with {signer.kind}. Relay connections are not logins. The header dot tracks trading relays.</p>
 <div className="relay-list">{states.map(s=><div className="relay-item" key={s.url}><div className="row"><span className="relay-url">{s.url}</span><span className={s.connected?'relay-up':'dim'}>{s.connected?'Up':'Down'}</span></div><p className="fine">{s.write?'Trading · read and publish':'Profile / follows · read only'}</p></div>)}</div>
 <p className="fine">{signer.kind==='bunker'?'Remote signer connection is separate; this list shows data relays only.':signer.kind==='extension'?'Extension manages its own signer connection.':'Local key signs on this device; no signer relay.'}</p>
 </section></div>
}
