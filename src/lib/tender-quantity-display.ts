import type { TenderQuantities } from './tender-quantities';

export function quantityReferences(data: TenderQuantities, sources: TenderQuantities['items'][number]['sources']) {
  const grouped = new Map<string, { document_id: string; pages: Set<number>; locations: Set<string>; evidence: string[] }>();
  for (const s of sources) {
    const key = s.document_id;
    let ref = grouped.get(key);
    if (!ref) { ref = { document_id: s.document_id, pages: new Set(), locations: new Set(), evidence: [] }; grouped.set(key, ref); }
    if (s.page !== null) ref.pages.add(s.page);
    ref.evidence.push(s.evidence);
    for (const o of data.rules.operands) if (o.source?.document_id === s.document_id && o.source.evidence === s.evidence && o.list_selection) {
      const sel = o.list_selection;
      const rows = sel.range.match(/\d+/g);
      if (rows?.[0]) ref.locations.add(`blad ${sel.sheet}, rad ${rows[0]}${rows[1] && rows[1] !== rows[0] ? `–${rows[1]}` : ''}`);
    }
  }
  return [...grouped.values()].map(r => ({ ...r, location: r.pages.size ? `s. ${[...r.pages].sort((a,b)=>a-b).join(', ')}` : [...r.locations].join('; ') || 'Textkälla', evidence: [...new Set(r.evidence)].join('\n') }));
}

export function assumptionItems(a: TenderQuantities['assumptions'][number]) {
  return [...(a.item?[a.item]:[]),...(a.related_items??[])];
}

export function uniqueQuantityAssumptions(values: TenderQuantities['assumptions']) {
  const result: TenderQuantities['assumptions'] = [];
  const words = (s: string) => new Set(s.toLocaleLowerCase('sv').match(/[a-zåäö]{6,}/g) ?? []);
  const standardRoom=(s:string)=>/(?:ett|en|1)/i.test(s)&&/(?:kök|badrum|vardagsrum)/i.test(s)&&/per lägenhet/i.test(s)&&/(?:standard|antas|antagande)/i.test(s);
  for (const value of values) {
    const a=standardRoom(value.description)?{...value,description:'Ett kök, ett badrum och ett vardagsrum per lägenhet antas som standard.'}:value;
    const aw = words(a.description);
    const existing = result.find(b => {
      if (a.description.trim().toLowerCase() === b.description.trim().toLowerCase()) return true;
      const sameCitation = a.sources.some(s => b.sources.some(t => s.document_id === t.document_id && s.page === t.page && s.evidence === t.evidence));
      const bw = words(b.description), shared = [...aw].filter(w => bw.has(w)).length;
      return sameCitation && shared >= 2 && shared / Math.max(1, Math.min(aw.size, bw.size)) >= 0.2;
    });
    if (!existing) result.push({ ...a, sources: [...a.sources] });
    else {
      const items=[...assumptionItems(existing),...assumptionItems(a)].filter((item,i,all)=>all.findIndex(x=>x.post===item.post)===i);
      existing.item=items[0]??null;
      if(items.length>1)existing.related_items=items.slice(1);
      existing.sources=[...existing.sources,...a.sources].filter((s,i,all)=>all.findIndex(x=>x.document_id===s.document_id&&x.page===s.page&&x.evidence===s.evidence)===i);
    }
  }
  return result;
}
