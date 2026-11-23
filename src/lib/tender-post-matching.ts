import { withoutNegatedTerms } from './tender-negation';
import type { CalculationSettings } from './tender-calculation';

const normalize=(s:string)=>s.toLocaleLowerCase('sv').normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/[^a-z0-9]+/g,' ').trim();
export function postMeaning(name:string) {
  // Excluded items in a post name ("exkl. diskmaskin") must not decide its meaning.
  const n=normalize(withoutNegatedTerms(name));
  if (/diskmaskin/.test(n)) return 'diskmaskin';
  if (/kyl|frys/.test(n)) return 'kylfrys';
  if (/perilex/.test(n)) return 'perilex';
  if (/projektering|projektor/.test(n)) return 'projektering';
  if (/provning|egenkontroll|relationshandling|dokumentation/.test(n)) return 'provning';
  if (/narvaro|rorelsevakt|rorelsedetektor/.test(n)) return 'narvarogivare';
  if (/nodbelysning|nodljus|nodarmatur|nodutrymning|vagledande markering/.test(n)) return 'nodbelysning';
  if (/potentialutjamning|skyddsutjamning|jordning/.test(n)) return 'jordning';
  if (/tomror/.test(n)&&/sol/.test(n)) return 'tomror-sol';
  if (/huvudledning/.test(n)) return /lagenhet/.test(n)?'huvudledning-lgh':/lokal/.test(n)?'huvudledning-lokal':/fastighet|huvudcentral/.test(n)?'huvudledning-fastighet':null;
  if (/central/.test(n)) return /lagenhet/.test(n)?'central-lgh':/lokal/.test(n)?'central-lokal':/fastighets|huvud/.test(n)?'central-fastighet':null;
  if (/brandvarnare/.test(n)) return 'brandvarnare';
  if (/matare|matning/.test(n)) return 'elmatare';
  if (/laddplat|laddning/.test(n)&&/ledning|installation|kabel/.test(n)) return 'laddledning';
  if (/handdukstork/.test(n)) return 'handdukstork';
  if (/spegelskap/.test(n)) return 'spegelskap';
  if (/dimmer/.test(n)) return 'dimmer';
  if (/lamputtag|takuttag|belysningsuttag/.test(n)) return 'lamputtag';
  if (/datauttag|natverk|rj45/.test(n)) return 'datauttag';
  if (/cee/.test(n)) return 'cee';
  if (/uttag/.test(n)) return /utomhus|fasad/.test(n)?'utomhusuttag':/ip44/.test(n)?'uttag-ip44':/16a/.test(n)?'uttag-16a':'vagguttag';
  if (/spot/.test(n)) return 'spot';
  if (/trapphusbelysning/.test(n)) return 'armatur-trapphus';
  if (/armatur/.test(n)) return /badrum/.test(n)?'armatur-badrum':/kok/.test(n)?'armatur-kok':/trapphus/.test(n)?'armatur-trapphus':/kallare/.test(n)?'armatur-kallare':null;
  if (/rivning/.test(n)) return 'rivning';
  if (/spis/.test(n)) return 'spis';
  if (/golvvarme/.test(n)) return 'golvvarme';
  return null;
}
// Deterministic fallback handles semantic equivalents, never inventing a catalog type or price.
export function closestTenderPostType(post:string, settings:CalculationSettings) {
  const exact=settings.post_types.find(t=>normalize(t.name)===normalize(post));
  if (exact) return exact.id;
  const kind=postMeaning(post);
  const candidates=kind ? settings.post_types.filter(t=>postMeaning(t.name)===kind) : [];
  // Prefer the same noun when duplicate semantic catalog types exist (Gruppcentral/Lägenhetscentral).
  const noun=normalize(post).split(' ')[0];
  return candidates.find(t=>normalize(t.name).split(' ')[0]===noun)?.id ?? candidates.at(-1)?.id ?? null;
}