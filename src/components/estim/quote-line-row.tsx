import { Button } from '@/components/ui/button';
import type { Quote } from '@/lib/quote';
import { Icon } from './icon';
import { useEstim } from './store-provider';

export function QuoteLineRow({ line: l, index }: { line: Quote['lines'][number]; index: number }) {
  const { actions } = useEstim();
  // Uncontrolled numeric fields preserve comma/space entry until the edit is committed.
  return <div className="lrow">
    <input className="input sm" aria-label={`Rad ${index + 1}`} defaultValue={l.t} onBlur={e => actions.upd(index, 't', e.target.value)} />
    <div className="row line-quantity"><input className="input sm" aria-label={`Antal rad ${index + 1}`} defaultValue={l.q.toLocaleString('sv-SE')} onBlur={e => actions.upd(index, 'q', e.target.value)} /><span className="xs muted">{l.u}</span></div>
    <input className="input sm line-price" aria-label={`À-pris rad ${index + 1}`} defaultValue={l.p} onBlur={e => actions.upd(index, 'p', e.target.value)} />
    <Button variant="prototype" className={`rotbtn ${l.rot && l.typ === 'arbete' ? 'on' : ''}`} title={l.typ === 'arbete' ? 'ROT på/av' : 'ROT gäller bara arbete'} aria-label={`ROT rad ${index + 1}`} aria-pressed={l.rot && l.typ === 'arbete'} onClick={() => actions.togRot(index)}>{l.typ === 'arbete' ? 'ROT' : '–'}</Button>
    <Button variant="prototype" className="line-delete" title="Ta bort rad" aria-label={`Ta bort rad ${index + 1}`} onClick={() => actions.delL(index)}><Icon name="trash" /></Button>
  </div>;
}