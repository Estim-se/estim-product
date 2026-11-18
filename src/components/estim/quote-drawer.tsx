import { Button } from '@/components/ui/button';
import { calc, kr } from '@/lib/quote';
import { Icon } from './icon';
import { QuoteLineRow } from './quote-line-row';
import { useEstim } from './store-provider';

export function QuoteDrawer() {
  const { state, actions } = useEstim();
  const t = state.threads.find(t => t.id === state.drawer), q = t?.q;
  if (!t || !q) return null;
  const c = calc(q, true), c0 = calc(q, false), hasAdd = q.lines.some(l => l.opt);
  return <><div className="dr-ov" onClick={actions.closeDrawer} /><section className="drawer" role="dialog" aria-modal="true" aria-labelledby="quote-heading">
    <div className="dr-h"><div><div className="eyebrow">Offert #{q.nr}</div><h2 id="quote-heading" className="overlay-heading">{t.job} · {t.name}</h2><div className="small muted mt4">Priser exkl. moms. AI:n räknar om svaret till kunden när du ändrar.</div></div><Button variant="prototype" className="xbtn" aria-label="Stäng offert" onClick={actions.closeDrawer}><Icon name="x" /></Button></div>
    <div className="dr-b"><div className="lrow h"><span>Rad</span><span>Antal</span><span className="line-price">À-pris</span><span>ROT</span><span /></div>
      {q.lines.map((l, i) => !l.opt && <QuoteLineRow key={`${i}-${q.lines.length}`} line={l} index={i} />)}
      <Button variant="prototype" className="btn btn-ghost btn-xs mt8" onClick={() => actions.addL()}><Icon name="plus" />Rad</Button>
      <div className="addbox"><div className="row between"><b className="small">Tillval kunden kan bocka i</b><Button variant="prototype" className="btn btn-ghost btn-xs" onClick={() => actions.addL(true)}><Icon name="plus" />Tillval</Button></div>{hasAdd ? q.lines.map((l, i) => l.opt && <QuoteLineRow key={`${i}-${q.lines.length}`} line={l} index={i} />) : <div className="xs muted mt8">Inga tillval. Lägg till t.ex. golvvärme eller extra uttag.</div>}</div>
      <div className="grid2 mt16"><div className="field"><label>Ägare som delar ROT</label><div className="seg">{[1, 2].map(n => <Button key={n} variant="prototype" className={q.owners === n ? 'on' : ''} aria-pressed={q.owners === n} onClick={() => actions.setOwners(n)}>{n} {n === 1 ? 'person' : 'personer'}</Button>)}</div></div><div className="field"><label>Prisform</label><div className="seg"><Button variant="prototype" className={q.prisform === 'fast' ? 'on' : ''} aria-pressed={q.prisform === 'fast'} onClick={() => actions.setPriceForm('fast')}>Fast pris</Button><Button variant="prototype" className={q.prisform !== 'fast' ? 'on' : ''} aria-pressed={q.prisform !== 'fast'} onClick={() => actions.setPriceForm('ungefar')}>Ungefärligt</Button></div></div></div>
      {q.prisform !== 'fast' && <div className="flag mt8"><Icon name="info" /><span>Ungefärligt pris får enligt konsumenttjänstlagen överskridas med högst 15 %.</span></div>}
      <div className="card mt16 mini-q"><div className="r"><span>Kunden betalar utan tillval</span><span>{kr(c0.betala)}</span></div>{hasAdd && <div className="r"><span>Med tillval</span><span>{kr(c.betala)}</span></div>}<div className="r av"><span>ROT-avdrag {hasAdd ? 'med tillval' : ''}</span><span>−{kr(c.av)}</span></div><div className="xs muted mt8">ROT: 30 % av arbetet inkl. moms, max 50 000 kr per ägare och år.</div></div>
    </div><div className="dr-f"><span className="small muted">{state.drafts[t.id] ? 'AI-svaret uppdateras med nya siffror' : 'Ändringen syns i kundens länk direkt'}</span><Button variant="prototype" className="btn btn-primary" onClick={() => { actions.closeDrawer(); actions.toast('Offerten är sparad'); }}><Icon name="check" />Spara</Button></div>
  </section></>;
}