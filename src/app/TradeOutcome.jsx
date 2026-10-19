import './trade-warning.css'
import { SettleMark } from './Orbit.jsx'
export default function TradeOutcome({ state, ownStamp, children }) {
 const disputed = state.status === 'disputed'
 if (state.status === 'conflict') return <div className="card done disputed"><SettleMark ok={false} /><div className="hero-word">Needs resolution.</div><p className="hint warn">Conflicting acceptances prevent treating this trade as settled. Preserve your payment records and contact the participants.</p>{children}</div>
 return <div className={`card done ${disputed ? 'disputed' : ownStamp.type}`}>
 <SettleMark ok={!disputed && ownStamp.type === 'settled'} />
 <div className="hero-word">{disputed ? 'Disputed.' : state.status === 'settled' ? 'Settled.' : 'You stamped settled.'}</div>
 {disputed && <p className="hint warn">A participant reported a dispute. Do not treat this trade as settled.</p>}
 <p className="dim">Your statement: {ownStamp.type}. These are signed statements, not payment proof.</p>
 {children}
 </div>
}
