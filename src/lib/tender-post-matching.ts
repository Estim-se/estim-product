import { withoutNegatedTerms } from './tender-negation';
import type { CalculationSettings } from './tender-calculation';

const normalize=(s:string)=>s.toLocaleLowerCase('sv').normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/[^a-z0-9]+/g,' ').trim();
// The meaning of a post or catalog name. Rules run from specific to general and use word boundaries, so a word inside
// another word never decides the meaning ("skyltar" is not "kyl", "vattenmätning" is not a supply line).
type Rule = [RegExp, string | ((n: string) => string | null)];
const RULES: Rule[] = [
  [/projektering|projektor|bygghandling|belysningsberakning/, 'projektering'],
  [/\bsyn\b|protokoll fore rivning|besiktning fore rivning/, 'syn'],
  // Removing the old centrals, feeders or installation is demolition, whatever the verb; dismantling for refitting
  // ("återmontering") is not.
  [/\brivning|\bdemonter/, n => /atermonter/.test(n) ? 'demontering' : /\brivning/.test(n) || /central|huvudledning|ledning|elinstallation|installation/.test(n) ? 'rivning' : 'demontering'],
  [/demonter|atermonter/, 'demontering'],
  // Temporary power and installations per stage ("Provisoriska installationer el, tele") are construction power.
  [/byggstrom|byggel\b|provisorisk el\b|provisoriska? (?:el|elinstallation|installation(?:er)?)\b/, 'byggstrom'],
  [/provisori/, 'provisorisk-matning'],
  [/tvattstuga/, 'tvattstuga'],
  // A component named in or at the service central ("Potentialutjämningsskena vid serviscentral") is the component.
  [/isolationsmatning|jordfelsbrytar\w*(?: ?test|prov)/, 'provning-lgh'],
  [/potentialutjamning|skyddsutjamning|jordning|inledningsskydd|overspanningsskydd/, n => {
    // The word that comes first is the post: "Serviscentral … inledningsskydd" is the central.
    const central = n.search(/serviscentral|servis\w* central/), part = n.search(/potentialutjamning|skyddsutjamning|jordning|inledningsskydd|overspanningsskydd/);
    return central >= 0 && central < part ? 'serviscentral' : 'jordning';
  }],
  [/serviscentral|servis\w* central/, 'serviscentral'],
  [/servisledning|serviskabel|servisanslutning|anslutningsavgift/, 'servisledning'],
  [/dimensionering|anmalan|natagare/, 'natagare'],
  [/golvvarme/, 'golvvarme'],
  [/handdukstork/, 'handdukstork'],
  [/\bwc\b/, 'wc'],
  [/diskmaskin/, 'diskmaskin'],
  [/\bkyl|\bfrys/, 'kylfrys'],
  [/mikro/, 'mikro'],
  [/spiskap|koksflakt|flaktkap/, 'spiskapa'],
  [/perilex|spishall|anslutning spis|\bspis\b/, 'perilex'],
  [/\bcee\b|industriuttag/, 'cee'],
  [/\bugn\b|\b16a\b/, 'uttag-16a'],
  [/\brivning/, 'rivning'],
  // Risers from the building central to the stairwells are one category, priced as the building's main feeders.
  [/stigarledning|stigare\b/, 'stigarledning'],
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
  // Coordination with operations in use is an electrical post; the general contractor's site safety coordination
  // (BAS-P/BAS-U, arbetsmiljö) is not.
  [/samordning|avbrottsplan/, n => /\bbas\b|bas [pu]\b|byggarbetsmiljo|arbetsmiljo|arbetsplatsorganisation|arbetarskydd/.test(n) ? null : 'samordning'],
  [/tomror/, n => /\bsol/.test(n) ? 'tomror-sol' : 'tomror-matning'],
  [/vattenmatning|\bbus\b/, 'tomror-matning'],
  [/kabelstege|kanalisation|kabelranna/, 'kanalisation'],
  [/total ?matare|total(?: \w+)? ?matning|huvudmatare|fastighetsmat/, 'totalmatare'],
  [/matarplats|matarblock|matartavl|debiteringsmatare|\belmatare\b|\bmatare\b/, 'matarplats'],
  [/\bspegelskap|\bbadrumsskap/, 'spegelskap'],
  // The washing-machine supply is its own category (one per apartment), whichever outlet type prices it.
  [/kombimaskin|tvattmaskin/, n => /tvattstuga/.test(n) ? 'tvattstuga' : 'kombimaskin'],
  // Each fed installation is its own category (lift, ventilation, district heating, ground heating), so a documented one
  // is never missing and the same one is not listed twice; the catalog's general feed types still price them.
  [/\bmatning\b|stromforsorjning|matande/, n => /\bhiss/.test(n) ? 'matning-hiss' : /flakt|ventilation/.test(n) ? 'matning-ventilation' : /fjarrvarme/.test(n) ? 'matning-fjarrvarme' : /markvarme/.test(n) ? 'matning-markvarme' : /funktionssaker/.test(n) ? 'matning-fs' : /dorrautomatik|dorroppnare/.test(n) ? 'dorrautomatik' : /varmepump|styrskap|teknisk/.test(n) ? 'matning-teknik' : null],
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
  [/central/, n => /garage/.test(n) ? 'central-garage' : /lagenhet/.test(n) ? 'central-lgh' : /lokal/.test(n) ? 'central-lokal' : /fastighets|huvud|elrum/.test(n) ? 'central-fastighet' : null],
];
export function postMeaning(name:string) {
  // Excluded items in a post name ("exkl. diskmaskin") must not decide its meaning.
  const n=normalize(withoutNegatedTerms(name));
  // A rule that recognises a word but no category lets the later rules decide.
  for (const [pattern, meaning] of RULES) if (pattern.test(n)) { const m = typeof meaning === 'string' ? meaning : meaning(n); if (m) return m; }
  return null;
}
// Meanings that cover different equipment (wall sockets, feeds to technical equipment, central parts …): never enough
// on their own to merge posts or to move a binding.
// Catalog types of these meanings price one package per unit even when several posts are bound to them
// ("Demontering och återmontering vid stambyte" per apartment): a generic meaning, but not different equipment.
export const PACKAGE_MEANINGS = new Set(['demontering', 'tvattstuga', 'serviscentral']);
// Categories without a catalog type of their own are priced with the type of this meaning (a lift feed with the
// fire-safe feed type, a washing-machine supply with the IP44 outlet type).
const PRICED_AS: Record<string, string> = { 'stigarledning': 'huvudledning-fastighet', 'matning-hiss': 'matning-fs', 'matning-ventilation': 'matning-fs', 'matning-fjarrvarme': 'matning-teknik', 'matning-markvarme': 'matning-teknik', 'kombimaskin': 'uttag-ip44' };
// The meaning a post is priced with in the catalog.
export const pricedAs = (meaning: string) => PRICED_AS[meaning] ?? meaning;
export const pricedMeaning = (post: string) => { const m = postMeaning(post); return m ? pricedAs(m) : null; };
function typesForMeaning(meaning: string, settings: CalculationSettings) {
  const own = settings.post_types.filter(t => postMeaning(t.name) === meaning);
  return own.length || !PRICED_AS[meaning] ? own : settings.post_types.filter(t => postMeaning(t.name) === PRICED_AS[meaning]);
}
export const GENERIC_MEANINGS = new Set(['vagguttag', 'lamputtag', 'uttag-ip44', 'matning-teknik', 'matning-fs', 'dorrautomatik', 'serviscentral', 'demontering', 'jordning', 'tvattstuga', 'wc', 'utomhusuttag', 'fasadstyrning']);
// A model binding whose catalog type means something else than the post itself moves to the catalog type of the
// post's own meaning when the post's meaning is specific and the catalog has such a type: the wrong scope (apartment vs
// common parts/premises) or another kind of work ("Armatur L2 ovan arbetsbänk" bound to the ceiling luminaire type).
// Generic meanings and posts without a meaning keep the model's binding.
const meaningFamily = (m: string) => /^uttag|vagguttag|utomhusuttag|bankuttag/.test(m) ? 'uttag' : m.split('-')[0] ?? m;
export function correctedScopeType(post: string, typeId: string | null, settings: CalculationSettings) {
  const type = settings.post_types.find(t => t.id === typeId);
  const own = postMeaning(post), bound = type ? postMeaning(type.name) : null;
  // A generic post moves only off a type of another kind of work ("Strömförsörjning kombimaskin" bound to the towel
  // rail type), never between types of the same family (outlets; demolition and dismantling).
  if (!own) return typeId;
  // Catalog types with the same specific meaning are synonyms: always the first one in the catalog, so the category of a
  // post does not depend on which synonym the model picked.
  if (own === bound || bound && PRICED_AS[own] === bound) return GENERIC_MEANINGS.has(own) ? typeId : typesForMeaning(own, settings)[0]?.id ?? typeId;
  // A generic post moves only off a type of another kind (never between outlet types, or onto a type from none).
  if (GENERIC_MEANINGS.has(own) && (!bound || meaningFamily(own) === meaningFamily(bound))) return typeId;
  const candidates = typesForMeaning(own, settings);
  if (!candidates.length) return typeId;
  return closestTenderPostType(post, { ...settings, post_types: candidates }) ?? typeId;
}
// Deterministic fallback handles semantic equivalents, never inventing a catalog type or price.
export function closestTenderPostType(post:string, settings:CalculationSettings) {
  const exact=settings.post_types.find(t=>normalize(t.name)===normalize(post));
  if (exact) return exact.id;
  const kind=postMeaning(post);
  // Without a type of the same meaning, a type of the same kind ("matning-hiss" → a feed type).
  const candidates=kind ? typesForMeaning(kind, settings) : [];
  // Prefer the same noun when duplicate semantic catalog types exist (Gruppcentral/Lägenhetscentral).
  const noun=normalize(post).split(' ')[0];
  return candidates.find(t=>normalize(t.name).split(' ')[0]===noun)?.id ?? candidates.at(-1)?.id ?? null;
}