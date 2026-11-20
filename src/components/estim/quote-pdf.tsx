import { useEffect } from 'react';
import demo from '@/data/demo.json';
import type { Thread } from '@/data/inbox';
import { calc, kr } from '@/lib/quote';
import { useWorkspace } from './workspace-provider';

// Printable quote document modelled on the customer's template. Company details come
// from the signed-in company (demo company in demo mode); customer details from the thread.
// "Ladda ner PDF" uses the browser's print dialog so the PDF matches the preview exactly.
export function QuotePdf({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const ws = useWorkspace();
  const q = thread.q!;
  const c = calc(q);
  const company = ws.mode === 'real' && ws.data?.company
    ? { name: ws.data.company.name, email: ws.data.company.reply_to_email ?? '' }
    : { name: demo.company.name, email: '' };
  const today = new Date();
  const valid = new Date(today.getTime() + 30 * 864e5);
  const date = (d: Date) => d.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' });
  const num = (n: number) => Math.round(n).toLocaleString('sv-SE');
  const estimate = q.prisform !== 'fast';

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.body.classList.add('pdf-open');
    window.addEventListener('keydown', key);
    return () => { document.body.classList.remove('pdf-open'); window.removeEventListener('keydown', key); };
  }, [onClose]);

  return <div className="pdf-overlay" role="dialog" aria-label={`Offert #${q.nr}`} onClick={onClose}>
    <div className="pdf-bar" onClick={e => e.stopPropagation()}>
      <b>Offert #{q.nr}</b>
      <span className="pdf-bar-actions">
        <button className="btn btn-primary btn-sm" onClick={() => window.print()}>Ladda ner PDF</button>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>Stäng</button>
      </span>
    </div>
    <article className="pdf-sheet" onClick={e => e.stopPropagation()}>
      <header className="pdf-head">
        <div>
          <div className="pdf-co">{company.name}</div>
          <div className="pdf-nr">Offert {q.nr}</div>
          <dl className="pdf-meta">
            <dt>Offertdatum</dt><dd>{date(today)}</dd>
            <dt>Giltig till</dt><dd>{date(valid)}</dd>
            <dt>Prisform</dt><dd>{estimate ? 'Uppskattning' : 'Fast pris'}</dd>
          </dl>
          <h1 className="pdf-title">Offert</h1>
        </div>
        <dl className="pdf-parties">
          <dt>Från</dt><dd>{company.name}{company.email && <><br />{company.email}</>}</dd>
          <dt>Till</dt><dd>{thread.name}{thread.addr && <><br />{thread.addr}</>}{thread.place && !thread.addr && <><br />{thread.place}</>}{thread.phone && <><br />{thread.phone}</>}{thread.email && <><br />{thread.email}</>}</dd>
        </dl>
      </header>
      <section className="pdf-row"><b>Uppdrag</b><p>{thread.job}</p></section>
      <section className="pdf-lines">
        <div className="pdf-lh"><b>Arbete &amp; material</b><b>Antal × à-pris</b><b className="r">Belopp kr</b></div>
        {c.L.map((l, i) => <div className="pdf-line" key={i}>
          <div>{l.t}<div className="pdf-sub">{l.typ === 'arbete' ? 'Arbete' : l.typ === 'material' ? 'Material' : 'Övrigt'}{l.opt ? ' · Tillval' : ''}</div></div>
          <div>{num(l.q)} {l.u} × {num(l.p)} kr</div><div className="r">{num(l.q * l.p)}</div>
        </div>)}
        <dl className="pdf-sum">
          <dt>Arbete</dt><dd>{num(c.arb)}</dd>
          <dt>Material</dt><dd>{num(c.mat)}</dd>
          <dt>Summa exkl. moms</dt><dd>{num(c.exkl)}</dd>
          <dt>Moms 25 %</dt><dd>{num(c.moms)}</dd>
          <dt>Totalt inkl. moms</dt><dd>{num(c.inkl)}</dd>
          {c.av > 0 && <><dt className="pdf-rot">ROT-avdrag 30 %</dt><dd className="pdf-rot">−{num(c.av)}</dd></>}
        </dl>
        <div className="pdf-total"><b>{c.av > 0 ? 'Efter ROT' : 'Totalt'}{estimate ? ', ca' : ''}</b><b>{kr(c.betala)}</b></div>
      </section>
      <section className="pdf-row"><b>Villkor</b><div>
        {estimate && <p>Priset är en uppskattning och bygger på standardmaterial från vår prislista. Dyrare produkter tillkommer.</p>}
        {c.av > 0 && <p>ROT-avdrag förutsätter att du har rätt till det.</p>}
      </div></section>
      <section className="pdf-sign"><div><b>Godkännande</b><p className="pdf-sub">Skriv under och skicka tillbaka.</p></div><div className="pdf-lines2"><span>Ort och datum</span><span>Underskrift</span></div></section>
      <footer className="pdf-foot">{company.name}{company.email && ` · ${company.email}`}</footer>
    </article>
  </div>;
}
