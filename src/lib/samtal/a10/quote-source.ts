// Source-backed company-catalog suggestions reuse the existing builder. Null quantities never become one or zero.
import { buildQuoteLines, type CatalogMoment } from '../../../../supabase/functions/_shared/build-quote';
import type { SourceRow } from './contracts';
export function catalogSuggestions(rows:SourceRow[], catalog:CatalogMoment[], company:{hourly_rate_ex_vat:number;travel_fee:number}) {
  if (rows.length>100 || catalog.length>1000) throw new Error('quote_source_limit');
  const unresolved:SourceRow[]=[];
  const items=rows.flatMap(row=>{
    const found=catalog.find(m=>m.id===row.moment_id);
    if (!found || row.quantity===null || !Number.isFinite(row.quantity) || row.quantity<=0 || !row.evidence || row.unit!==found.unit) { unresolved.push(row); return []; }
    return [{moment_id:found.id,moment_name:row.description,quantity:row.quantity,unit:row.unit}];
  });
  const built=buildQuoteLines(items,catalog,company);
  return {...built,unresolved};
}
export function appendReviewedLines<T>(existing:readonly T[],additional:readonly T[],intent:string):T[] {
  if (intent==='quote_change') throw new Error('explicit_full_revision_required');
  if (existing.length+additional.length>200) throw new Error('quote_line_limit');
  return [...existing,...additional];
}
