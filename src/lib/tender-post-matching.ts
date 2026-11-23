import { withoutNegatedTerms } from './tender-negation';
import type { CalculationSettings } from './tender-calculation';

const normalize=(s:string)=>s.toLocaleLowerCase('sv').normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/[^a-z0-9]+/g,' ').trim();
// The meaning of a post or catalog name. Rules run from specific to general and use word boundaries, so a word inside
// another word never decides the meaning ("skyltar" is not "kyl", "vattenmätning" is not a supply line).
type Rule = [RegExp, string | ((n: string) => string | null)];
const RULES: Rule[] = [
  [/projektering|projektor|bygghandling|belysningsberakning/, 'projektering'],
  [/\bsyn\b|protokoll fore rivning|besiktning fore rivning/, 'syn'],
  [/demonter|atermonter/, 'demontering'],
  [/byggstrom|byggel\b|provisorisk el\b/, 'byggstrom'],
  [/provisori/, 'provisorisk-matning'],
  [/tvattstuga/, 'tvattstuga'],
  [/serviscentral|servis\w* central/, 'serviscentral'],
  [/servisledning|serviskabel|servisanslutning|anslutningsavgift/, 'servisledning'],
  [/dimensionering|anmalan|natagare/, 'natagare'],
  [/golvvarme/, 'golvvarme'],
  [/handdukstork/, 'handdukstork'],
  [/\bwc\b/, 'wc'],
  [/diskmaskin/, 'diskmaskin'],
  [/\bkyl|\bfrys/, 'kylfrys'],
  [/mikro/, 'mikro'],
  [/spiskapa|koksflakt|flaktkapa/, 'spiskapa'],
  [/perilex|spishall|anslutning spis|\bspis\b/, 'perilex'],
  [/\bcee\b|industriuttag/, 'cee'],
  [/\bugn\b|\b16a\b/, 'uttag-16a'],
  [/rivning/, 'rivning'],
  [/huvudledning/, n => /lagenhet/.test(n) ? 'huvudledning-lgh' : /lokal/.test(n) ? 'huvudledning-lokal' : /fastighet|huvudcentral/.test(n) ? 'huvudledning-fastighet' : null],
  [/provning/, n => /allmanna|funktionsprovning|samordnad/.test(n) ? 'provning-allm' : 'provning-lgh'],
  // Insulation measurement and RCD tests are the installation test per apartment, not an earthing post.
  [/isolationsmatning|jordfelsbrytar\w*(?: ?test|prov)/, 'provning-lgh'],
  [/kvalitetsplan|egenkontroll/, 'kvalitetsplan'],
  [/relationshandling/, 'relationshandling'],
  // Training of operating staff is its own post, also when the staff is called "drift- och underhållspersonal".
  [/utbildning/, 'utbildning'],
  [/drift\w* och underhall|\bdu parm/, 'du-parm'],
  [/servicebesok|garantibesok/, 'servicebesok'],
  [/markning|\bskyltar|gruppforteckning/, 'markning'],
  [/haltagning|bilning|brandtatning/, 'haltagning'],
  [/samordning|avbrottsplan/, 'samordning'],
  [/tomror/, n => /\bsol/.test(n) ? 'tomror-sol' : 'tomror-matning'],
  [/vattenmatning|\bbus\b/, 'tomror-matning'],
  [/kabelstege|kanalisation|kabelranna/, 'kanalisation'],
  [/potentialutjamning|skyddsutjamning|jordning/, 'jordning'],
  [/totalmatare|total matning|huvudmatare/, 'totalmatare'],
  [/matarplats|matarblock|debiteringsmatare|\belmatare\b|\bmatare\b/, 'matarplats'],
  [/\bspegelskap/, 'spegelskap'],
  [/kombimaskin|tvattmaskin/, 'uttag-ip44'],
  [/\bmatning\b/, n => /hiss|flakt|ventilation|funktionssaker/.test(n) ? 'matning-fs' : /dorrautomatik|dorroppnare/.test(n) ? 'dorrautomatik' : /fjarrvarme|markvarme|varmepump|styrskap|teknisk/.test(n) ? 'matning-teknik' : null],
  [/dorrautomatik|dorroppnare/, 'dorrautomatik'],
  [/laddplat|laddning/, n => /ledning|installation|kabel|forberedelse/.test(n) ? 'laddledning' : null],
  [/brandvarnare/, 'brandvarnare'],
  [/dimmer|tryckknapp/, 'dimmer'],
  [/lampstick|stickpropp|\be27\b/, 'lampstickpropp'],
  [/lamputtag|takuttag|belysningsuttag|\bdcl\b/, 'lamputtag'],
  [/datauttag|natverk|rj45/, 'datauttag'],
  [/bankuttag|hornbox|koksuttag/, 'bankuttag'],
  [/uttag/, n => /utomhus|fasad/.test(n) ? 'utomhusuttag' : /ip44/.test(n) ? 'uttag-ip44' : 'vagguttag'],
  [/fasad/, n => /belysning|armatur|styrning|kopplingsur/.test(n) ? 'fasadstyrning' : null],
  [/bankbelysning|overskap|\bl2\b|arbetsbank/, 'bankbelysning'],
  [/armatur|belysning/, n => /\bnod/.test(n) ? 'nodbelysning' : /garage/.test(n) ? 'armatur-garage' : /trapphus|\bl4\b/.test(n) ? 'armatur-trapphus' : /kallar|forrad|teknikrum/.test(n) ? 'armatur-kallare' : /badrum|\bl5\b/.test(n) ? 'armatur-badrum' : /\bkok|\bl1\b/.test(n) ? 'armatur-kok' : null],
  [/nodljus|nodutrymning|vagledande markering/, 'nodbelysning'],
  [/narvaro|rorelsevakt|rorelsedetektor/, 'narvarogivare'],
  [/\bspot/, 'spot'],
  [/central/, n => /garage/.test(n) ? 'central-garage' : /lagenhet/.test(n) ? 'central-lgh' : /lokal/.test(n) ? 'central-lokal' : /fastighets|huvud/.test(n) ? 'central-fastighet' : null],
];
export function postMeaning(name:string) {
  // Excluded items in a post name ("exkl. diskmaskin") must not decide its meaning.
  const n=normalize(withoutNegatedTerms(name));
  for (const [pattern, meaning] of RULES) if (pattern.test(n)) return typeof meaning === 'string' ? meaning : meaning(n);
  return null;
}
// A binding of the right kind but the wrong scope (apartment vs common parts/premises: provning, central, huvudledning)
// moves to the catalog type of the post's own scope when the catalog has one; otherwise the binding is kept.
export function correctedScopeType(post: string, typeId: string | null, settings: CalculationSettings) {
  const type = settings.post_types.find(t => t.id === typeId);
  const own = postMeaning(post), bound = type ? postMeaning(type.name) : null;
  if (!own || !bound || own === bound || own.split('-')[0] !== bound.split('-')[0]) return typeId;
  return settings.post_types.find(t => postMeaning(t.name) === own)?.id ?? typeId;
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