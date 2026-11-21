import type { TenderQuantities } from './tender-quantities';

export function quantityReferences(data: TenderQuantities, sources: TenderQuantities['items'][number]['sources']) {
  const grouped = new Map<string, { document_id: string; page: number | null; locations: Set<string>; evidence: string[] }>();
  for (const s of sources) {
    const key = `${s.document_id}|${s.page}`;
    let ref = grouped.get(key);
    if (!ref) { ref = { document_id: s.document_id, page: s.page, locations: new Set(), evidence: [] }; grouped.set(key, ref); }
    ref.evidence.push(s.evidence);
    for (const o of data.rules.operands) if (o.source?.document_id === s.document_id && o.source.evidence === s.evidence && o.list_selection) {
      const sel = o.list_selection;
      const rows = sel.range.match(/\d+/g);
      if (rows?.[0]) ref.locations.add(`blad ${sel.sheet}, rad ${rows[0]}${rows[1] && rows[1] !== rows[0] ? `–${rows[1]}` : ''}`);
    }
  }
  return [...grouped.values()].map(r => ({ ...r, location: r.page === null ? [...r.locations].join('; ') || 'Textkälla' : `s. ${r.page}`, evidence: [...new Set(r.evidence)].join('\n') }));
}

export function uniqueQuantityAssumptions(values: TenderQuantities['assumptions']) {
  const result: TenderQuantities['assumptions'] = [];
  const words = (s: string) => new Set(s.toLocaleLowerCase('sv').match(/[a-zåäö]{6,}/g) ?? []);
  for (const a of values) {
    const aw = words(a.description);
    const existing = result.find(b => {
      if (a.item && b.item && a.item.post !== b.item.post) return false;
      if (a.description.trim().toLowerCase() === b.description.trim().toLowerCase()) return true;
      const sameCitation = a.sources.some(s => b.sources.some(t => s.document_id === t.document_id && s.page === t.page && s.evidence === t.evidence));
      const bw = words(b.description), shared = [...aw].filter(w => bw.has(w)).length;
      return sameCitation && shared >= 2 && shared / Math.max(1, Math.min(aw.size, bw.size)) >= 0.2;
    });
    if (!existing) result.push({ ...a, sources: [...a.sources] });
    else { existing.item = existing.item ?? a.item; existing.sources = [...existing.sources, ...a.sources]; }
  }
  return result;
}
