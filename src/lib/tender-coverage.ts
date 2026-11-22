import type { TenderQuantities } from './tender-quantities';
import { assumptionItems } from './tender-quantity-display';
export const TENDER_ELECTRICAL_SCOPE = [
  ['demolition', 'Rivning', /rivning|demontering/i],
  ['central', 'Servis/fastighetscentral', /servis|fastighetscentral|huvudcentral/i],
  ['feeders', 'Huvudledningar', /huvudledning|stigarledning|stigare/i],
  ['panels', 'Gruppcentraler', /gruppcentral|lägenhetscentral/i],
  ['metering', 'Mätning', /elmät|mätare|mätning/i],
  ['room_sockets', 'Uttag per rumstyp', /vägguttag|uttag.*(?:rum|hall)|(?:rum|hall).*uttag/i],
  ['kitchen', 'Kök', /kök|spis|perilex|diskmaskin|kyl|frys/i],
  ['bathroom', 'Badrum', /badrum|ip44|golvvärme|handdukstork|spegelskåp/i],
  ['apartment_lights', 'Belysning lägenhet', /spotlight|takuttag|lamputtag|belysning.*lägenhet|armatur.*(?:rum|kök|badrum)/i],
  ['shared_lights', 'Trapphus/källare/förråd', /trapphus|källar|förråd/i],
  ['outdoor', 'Utomhus', /utomhus|fasad|ytterbelysning|gård/i],
  ['charging', 'Laddplatser', /laddplats|laddbox|laddstation/i],
  ['smoke', 'Brandvarnare', /brandvarnare/i],
  ['data', 'Tele/data', /tele|datauttag|datanät|kommunikationsnät/i],
  ['conduits', 'Kanalisation', /kanalisation|kabelstege|kabelränna|installationsrör/i],
  ['earthing', 'Jordning/potentialutjämning', /jordning|potentialutjämning/i],
  ['testing', 'Provning och dokumentation', /provning|dokumentation|besiktning|relationshandling/i],
  ['design', 'Projektering', /projektering|projektör/i],
] as const;
export type TenderCoverageRow = { id: string; area: string; status: 'Prissatt' | 'Ingår ej' | 'Mängd saknas'; reason: string; sources: TenderQuantities['items'][number]['sources'] };
export function tenderCoverage(q: TenderQuantities, priced: { post: string; total: number | null }[]): TenderCoverageRow[] {
  const items = [...q.items, ...q.assumptions.flatMap(assumptionItems)];
  return TENDER_ELECTRICAL_SCOPE.map(([id, area, pattern]) => {
    const relevant = items.filter(i => pattern.test(i.post));
    const rows = relevant.map(i => priced.find(r => r.post === i.post));
    const exclusion = q.assumptions.find(a => /^Ingår ej\s*:/i.test(a.description) && pattern.test(a.description) && a.sources.length > 0 && a.sources.every(s => !!s.evidence));
    const pricedAll = relevant.length > 0 && rows.every(r => r && r.total !== null);
    return { id, area, status: pricedAll ? 'Prissatt' : !relevant.length && exclusion ? 'Ingår ej' : 'Mängd saknas', reason: pricedAll ? `${relevant.length} katalogmatchade poster prissatta` : !relevant.length && exclusion ? exclusion.description : relevant.length ? 'Omfattningen är inte fullt prissatt; kontrollera mängd, posttyp och bekräftelse.' : 'Ingen fullständig mängdregel har hittats – kontrollera underlaget.', sources: relevant.length ? relevant.flatMap(i => i.sources) : exclusion?.sources ?? [] };
  });
}