import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import demo from '@/data/demo.json';
import type { Thread } from '@/data/inbox';
import { calc, kr } from '@/lib/quote';
import { useWorkspace } from './workspace-provider';

// Printable quote document modelled on the customer's template. Company details come
// from the signed-in company (demo company in demo mode); customer details from the thread.
// "Ladda ner PDF" uses the browser's print dialog so the PDF matches the preview exactly.
export function QuotePdf({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const ws = useWorkspace();
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    setPortalTarget(document.body);
    const opener = document.activeElement;
    const bodyOverflow = document.body.style.overflow;
    const rootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    document.body.classList.add('pdf-open');
    return () => {
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = rootOverflow;
      document.body.classList.remove('pdf-open');
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (!portalTarget) return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = () => Array.from(panel.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(el => el.getClientRects().length > 0);
    const focusFirst = () => (focusable()[0] ?? panel).focus({ preventScroll: true });
    focusFirst();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current(); }
      if (e.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) { e.preventDefault(); panel.focus(); return; }
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    const focus = (e: FocusEvent) => { if (e.target instanceof Node && !panel.contains(e.target)) focusFirst(); };
    document.addEventListener('keydown', key, true);
    document.addEventListener('focusin', focus);
    return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('focusin', focus); };
  }, [portalTarget]);
  const q = thread.q;
  if (!q || !portalTarget) return null;
  const c = calc(q);
  const company = ws.mode === 'real' && ws.data?.company
    ? { name: ws.data.company.name, email: ws.data.company.reply_to_email ?? '' }
    : { name: demo.company.name, email: '' };
  const today = new Date();
  const valid = new Date(today.getTime() + 30 * 864e5);
  const date = (d: Date) => d.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' });
  const num = (n: number) => Math.round(n).toLocaleString('sv-SE');
  const estimate = q.prisform !== 'fast';

  return createPortal(<div className="ov pdf-overlay" onClick={onClose}>
    <section ref={panelRef} className="md pdf-panel" role="dialog" aria-modal="true" aria-label={`Offert #${q.nr}`} tabIndex={-1} onClick={e => e.stopPropagation()}>
    <div className="md-h pdf-bar">
      <b>Offert #{q.nr}</b>
      <span className="pdf-bar-actions">
        <Button variant="prototype" className="btn btn-primary btn-sm" onClick={() => window.print()}>Ladda ner PDF</Button>
        <Button variant="prototype" className="btn btn-ghost btn-sm" onClick={onClose}>Stäng</Button>
      </span>
    </div>
    <div className="pdf-document" tabIndex={0} aria-label="Offertdokument">
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
    </div>
    </section>
  </div>, portalTarget);
}
