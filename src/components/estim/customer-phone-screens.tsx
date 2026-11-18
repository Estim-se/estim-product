import { Button } from '@/components/ui/button';
import type { Thread } from '@/data/inbox';
import { calc, calcAdd, kr } from '@/lib/quote';
import { Icon } from './icon';
import { useEstim } from './store-provider';

export function CustomerPhoneScreens({ thread: t, preview }: { thread: Thread; preview?: boolean }) {
  const { state, actions } = useEstim(), q = t.q;
  if (!q) return null;
  const c = calc(q), a = q.lines.some(l => l.opt) ? calcAdd(q) : null, fn = t.name.split(' ')[0];
  const top = <>{preview && <div className="prevbar">Förhandsvisning</div>}<div className={`cp-top ${preview ? 'preview-top' : ''}`}><div className="brand"><i>VV</i>Volt Vision</div><div className="xs customer-quote-number">Offert #{q.nr} · {q.prisform === 'fast' ? 'fast pris' : 'ungefärligt pris'}</div></div></>;
  if (state.cust.step === 'bankid') return <div className="bankid"><div className="bigspin" /><h3>Öppna BankID</h3><p className="small muted">Signera offert #{q.nr} från Volt Vision.<br /><b className="customer-amount">{kr(c.betala)}</b> efter ROT</p></div>;
  if (state.cust.step === 'info') return <>{top}<form className="cp-b" onSubmit={e => { e.preventDefault(); actions.submitCustomer(); }}><span className="chip chip-green"><Icon name="check" />Signerat</span><h2 className="mt12">Sista steget</h2><p className="small muted mt4">Uppgifterna behövs för ROT. De skickas krypterat, inte i ett mejl.</p>
    <div className="field mt16"><label htmlFor="customer-person">Personnummer</label><input id="customer-person" className="input" value="19850312-••••" disabled /><span className="xs muted">Hämtat från BankID</span></div>
    {t.place.startsWith('BRF') ? <><div className="field mt12"><label htmlFor="customer-apartment">Lägenhetsnummer</label><input id="customer-apartment" className="input" defaultValue="1102" /></div><div className="field mt12"><label htmlFor="customer-organization">Föreningens org.nr</label><input id="customer-organization" className="input" defaultValue="769600-0000" /></div></> : <div className="field mt12"><label htmlFor="customer-property">Fastighetsbeteckning</label><input id="customer-property" className="input" placeholder="Står i lagfarten" /></div>}
    {q.owners > 1 && <div className="field mt12"><label htmlFor="customer-owner">Medägare</label><input id="customer-owner" className="input" placeholder="Namn" /><span className="xs muted">Hen får en egen BankID-länk för sin del</span></div>}<Button variant="prototype" className="cbtn" type="submit">Skicka</Button>
  </form></>;
  if (state.cust.step === 'klar') return <>{top}<div className="cp-b customer-done"><div className="okmark"><Icon name="check" /></div><h2 className="mt16">Tack {fn}!</h2><p className="small muted mt8">Volt Vision har fått ditt godkännande och hör av sig för att boka tid.</p><Button variant="prototype" className="cbtn sec mt16" onClick={actions.closeCustomer}>Stäng</Button></div></>;
  return <>{top}<div className="cp-b"><h2>Hej {fn}!</h2><p className="small mt8 customer-intro">Här är offerten för {t.job.toLowerCase()}. Fråga oss gärna direkt här om något är oklart.</p>
    <div className="copt on"><div className="xs muted">Du betalar</div><div className="pay">{kr(c.betala)}</div><div className="xs muted">Totalt {kr(c.inkl)} inkl. moms · ROT −{kr(c.av)}</div></div>
    {a && <Button variant="prototype" role="switch" aria-checked={q.addOn} aria-label="Golvvärme tillval" className={`copt customer-option ${q.addOn ? 'on' : ''}`} onClick={() => actions.toggleAddOn(t.id)}><span className={`toggle ${q.addOn ? 'on' : ''}`} /><span><b>{a.name?.replace('Tillval: ', '').replace(', material', '')}</b><span className="xs muted customer-option-price">+{kr(a.betala)} efter ROT ({kr(a.inkl)} före)</span></span></Button>}
    <div className="cinfo"><Icon name="info" /> ROT-avdraget dras direkt på fakturan.{q.owners > 1 ? ' Ni är två ägare, så utrymmet är upp till 100 000 kr.' : ''}</div><div className="eyebrow mt16">Det här ingår</div><div className="clines">{c.L.map((l, i) => <div key={i}><span>{l.t.replace('Tillval: ', '')}</span><span>{kr(l.q * l.p * 1.25)}</span></div>)}</div>
    <Button variant="prototype" className="cbtn" onClick={actions.approveCustomer}>Godkänn med BankID</Button><Button variant="prototype" className="cbtn sec" onClick={() => actions.toast('Frågan hamnar i tråden och AI:n föreslår ett svar')}>Ställ en fråga</Button>
  </div></>;
}