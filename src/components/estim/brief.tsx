import type { Thread } from '@/data/inbox';
import demo from '@/data/demo.json';
import { calc, kr } from '@/lib/quote';
import { Button } from '@/components/ui/button';
import { Icon } from './icon';
import { useEstim } from './store-provider';

export function Brief({ thread: t }: { thread: Thread }) {
  const { state, actions } = useEstim();
  if (!t.q) return null;
  const c = calc(t.q);
  return <div className={`brief${state.hl === 'brief' ? ' hl' : ''}`} data-hl="brief"><div className="row between wrap"><div className="row brief-heading"><span className="chi"><Icon name="user" /></span><div><b>Överlämning till elektrikern</b><div className="sub small">Skriven av AI från konversationen</div></div></div><span className="chip chip-lime">{t.briefSent ? 'Skickad' : 'Redo att skicka'}</span></div>
    <dl><dt>Jobb</dt><dd>{t.job}{t.q.addOn && t.q.lines.some(l => l.opt) ? ' + golvvärme i badrummet (tillval)' : ''}</dd><dt>Adress</dt><dd>{t.addr}</dd><dt>Kund</dt><dd>{t.name} · {t.phone !== '—' ? t.phone : t.email} · föredrar {demo.channels[t.ch as keyof typeof demo.channels]?.[0]?.toLowerCase()}</dd><dt>Pris</dt><dd>Fast pris {kr(c.betala)} efter ROT (offert #{t.q.nr})</dd><dt>Önskad tid</dt><dd>{t.week || 'Enligt överenskommelse'}</dd><dt>Bra att veta</dt><dd>{t.id === 'lind' ? 'Föreningen har fått försäkringsbevis och auktorisation. Två ägare, ROT läggs på Sara.' : t.id === 'anna' ? '25 A huvudsäkring. Laddbox vid carporten.' : 'Bilder från kunden finns i tråden.'}</dd></dl>
    <div className="row mt16 wrap brief-footer">{t.briefSent ? <span className="small brief-sent"><Icon name="check" />Skickad till elektrikern via SMS · PDF mejlad till order@voltvision.se</span> : <><Button variant="prototype" className="btn btn-lime btn-sm" onClick={() => actions.sendBrief(t.id)}><Icon name="send" />Skicka till elektrikern och order@</Button><span className="xs brief-note">PDF:en funkar med Entré, Fortnox eller pärmen.</span></>}</div></div>;
}