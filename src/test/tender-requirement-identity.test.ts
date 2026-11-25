import { describe, expect, it } from 'vitest';
import { buildObjectModel } from '@/lib/tender-object-model';
import { buildRequirementQuantities, decodeRequirements, stableRequirementId, type Requirement } from '@/lib/tender-requirements';
import { combineRequirementAnswers, REQUIREMENT_SECTION_GROUPS, thinSectionGroups } from '@/lib/tender-requirements-ai.server';
import { exampleRoomRecipes } from '@/lib/tender-room-recipes';

// Synthetic tender (no customer data): 6 apartments, 2 premises, and a technical description with the quoted lines.
const xlsx = '00000000-0000-4000-8000-000000000001', pdf = '00000000-0000-4000-8000-000000000002', pdf2 = '00000000-0000-4000-8000-000000000003';
const rows = ['1 rum o kök', '2 rum o kök', '3 rum o kök', '2 rum o kök', '3 rum o kök', '4 rum o kök'];
const list = ['Blad: Objekt', 'A1: Lägenhetsnr\tB1: Typ\tC1: Area', ...rows.map((t, i) => `A${i + 2}: ${1101 + i}\tB${i + 2}: ${t}\tC${i + 2}: ${40 + i * 10}`), 'A8: 9001\tB8: Lokal\tC8: 120', 'A9: 9002\tB9: Lokal\tC9: 80'].join('\n');
const text = 'Fysisk sida: 1\nEntreprenaden indelas i följande etapper.\nHus A etapp 1\nHus B etapp 2\nHus C etapp 3\nLokaler\nNya stigarledningar i varje trapphus.\nMatning till hiss.\nMatning till fläktar.\nRivning i lägenheter.\nRivning i lokaler.\nElektrisk golvvärme i samtliga badrum.';
const documents = [{ id: xlsx, file_name: 'Objekt.xlsx', file_type: 'xlsx', page_count: null, text: list }, { id: pdf, file_name: 'El.pdf', file_type: 'pdf', page_count: 1, text },
  { id: pdf2, file_name: 'Rambeskrivning.pdf', file_type: 'pdf', page_count: 1, text: 'Fysisk sida: 1\nGolvvärme installeras i varje badrum.' }];
const model = buildObjectModel(documents)!;
const T = { feed: '00000000-0000-4000-8000-000000000501', riv: '00000000-0000-4000-8000-000000000502', golv: '00000000-0000-4000-8000-000000000503', perilex: '00000000-0000-4000-8000-000000000504',
  ip44: '00000000-0000-4000-8000-000000000505', u16: '00000000-0000-4000-8000-000000000506', bygg: '00000000-0000-4000-8000-000000000507', wc: '00000000-0000-4000-8000-000000000508', spis: '00000000-0000-4000-8000-000000000509', bank: '00000000-0000-4000-8000-000000000513' };
const catalog = [{ id: T.feed, name: 'Matning med funktionssäker kabel' }, { id: T.riv, name: 'Rivning per lägenhet' }, { id: T.golv, name: 'Anslutning golvvärme' }, { id: T.perilex, name: 'Perilexuttag' },
  { id: T.ip44, name: 'Dubbelt uttag IP44' }, { id: T.u16, name: 'Vägguttag 16A' }, { id: T.bygg, name: 'Byggström per etapp' }, { id: T.wc, name: 'Separat WC: belysning och spegelskåp' }, { id: T.spis, name: 'Anslutning spis' }, { id: T.bank, name: 'Bänkbelysning under överskåp' }];
const src = (evidence: string, document_id = pdf) => ({ document_id, page: 1, evidence });
const req = (post: string, unit_of_count: Requirement['unit_of_count'], per_unit: number | null, extra: Partial<Requirement> = {}): Requirement =>
  ({ post, section: 3, unit_of_count, per_unit, fixed_quantity: null, area_divisor: null, unit: 'st', assumed: false, note: null, source: null, ...extra });
const build = (requirements: Requirement[], gaps: { category: string; quote: string }[] = []) => buildRequirementQuantities(decodeRequirements({ requirements, counts: [] }), model, documents, exampleRoomRecipes, null, catalog, gaps);
const rowsOf = (q: ReturnType<typeof build>) => [...q.items, ...q.assumptions.flatMap(a => a.item ? [a.item] : [])].filter(i => !/typrecept/.test(i.post));
const status = (q: ReturnType<typeof build>, post: string) => q.coverage?.find(c => c.post === post);

const golvA = req('Elektrisk golvvärme badrum', 'badrum', 1, { type_id: T.golv, work: 'golvvärme', source: src('Elektrisk golvvärme i samtliga badrum.') });
const golvB = req('Golvvärme i badrum', 'badrum', 1, { type_id: T.golv, work: 'golvvärme', source: src('Golvvärme installeras i varje badrum.', pdf2) });
const hiss = req('Matning hiss', 'fastighet', null, { fixed_quantity: 2, type_id: T.feed, work: 'hiss', section: 7, source: src('Matning till hiss.') });
const flakt = req('Matning fläktar', 'fastighet', null, { fixed_quantity: 1, type_id: T.feed, work: 'fläktar', section: 7, source: src('Matning till fläktar.') });
const rivLgh = req('Rivning lägenheter', 'lägenhet', 1, { type_id: T.riv, work: 'rivning', section: 1, source: src('Rivning i lägenheter.') });
const rivLokal = req('Rivning lokaler', 'lokal', 1, { type_id: T.riv, work: 'rivning', section: 1, source: src('Rivning i lokaler.') });

describe('requirement identity and deduplication', () => {
  it('the same requirement in other words, from two files, is one row with both sources; the identity does not depend on the wording', () => {
    const q = build([golvA, golvB]);
    expect(rowsOf(q).filter(i => i.type_id === T.golv)).toHaveLength(1);
    const row = rowsOf(q).find(i => i.type_id === T.golv)!;
    expect(row).toMatchObject({ quantity: '6' }); expect(row.sources.filter(s => s.document_id !== xlsx)).toHaveLength(2);
    expect(q.coverage?.filter(c => c.row === row.post).map(c => c.status).sort()).toEqual(['Ingår i annan post', 'Kalkylerad']);
    const ids = q.coverage!.filter(c => /olvvärme/.test(c.post)).map(c => c.requirement_id);
    expect(new Set(ids).size).toBe(1);
  });
  it('different deliveries on the same general catalog type stay separate; the same type in different places stays separate', () => {
    const q = build([hiss, flakt, rivLgh, rivLokal]);
    expect(rowsOf(q).filter(i => i.type_id === T.feed).map(i => i.quantity).sort()).toEqual(['1', '2']);
    expect(rowsOf(q).filter(i => i.type_id === T.riv).map(i => i.quantity).sort()).toEqual(['2', '6']);
  });
  it('an unknown catalog id or no catalog type is Saknar pris, visibly, never forced into a type', () => {
    const q = build([req('Laddbox', 'fastighet', null, { fixed_quantity: 4, type_id: 'ingen-sadan-typ', section: 6, source: src('Matning till hiss.') }), req('Säkerhetsdörr', 'lägenhet', 1, { type_id: null, section: 1, source: src('Rivning i lägenheter.') })]);
    expect(status(q, 'Laddbox')).toMatchObject({ status: 'Saknar pris', validation: ['okänd katalog-ID ingen-sadan-typ'] });
    expect(status(q, 'Säkerhetsdörr')?.status).toBe('Saknar pris');
    expect(rowsOf(q).find(i => i.post === 'Laddbox')?.type_id).toBeNull();
  });
  it('"one per X" never becomes 0: a missing number per unit is at least one, a length is never guessed; a missing source is flagged', () => {
    const q = build([req('Belysning källare', 'fastighet', null, { type_id: T.feed, work: 'belysning källare', section: 6, source: src('Matning till fläktar.') }),
      req('Kabelstege', 'fastighet', null, { unit: 'm', type_id: T.feed, work: 'kabelstege', section: 6, source: src('Matning till fläktar.') }), req('Golvvärme', 'badrum', 1, { type_id: T.golv })]);
    const row = (post: string) => rowsOf(q).find(i => i.post === post);
    expect(row('Belysning källare')).toMatchObject({ quantity: '1', level: 'Antagen' }); expect(row('Belysning källare')?.rule).toMatch(/antaget minst 1 per fastighet/);
    expect(status(q, 'Kabelstege')?.status).toBe('Saknar mängd');
    expect(status(q, 'Golvvärme')).toMatchObject({ status: 'Antagen', validation: ['källa saknas'] });
  });
  it('an unknown number of spaces is assumed from stairwells, buildings, apartments and floors, marked Antagen with the reason', () => {
    // The synthetic object list has addresses (stairwells) but no stated entrances, floors 1 only, two buildings in the text.
    const counts = [{ name: 'huskropp' as const, value: 2, source: src('Matning till hiss.') }];
    const input = (r: Requirement[]) => buildRequirementQuantities(decodeRequirements({ requirements: r, counts }), model, documents, exampleRoomRecipes, null, catalog);
    const q = input([req('Uttag källargångar', 'rumstyp', 1, { room_type: 'källargång', section: 6, source: src('Matning till fläktar.') }),
      req('CEE-uttag teknikrum', 'rumstyp', 1, { room_type: 'teknikrum', section: 6, source: src('Matning till fläktar.') }),
      req('Belysning lägenhetsförråd', 'rumstyp', 1, { room_type: 'lägenhetsförråd', section: 6, source: src('Matning till fläktar.') }),
      req('Matning dörrautomatik', 'entré', 1, { type_id: T.feed, section: 7, source: src('Matning till hiss.') })]);
    const row = (post: string) => [...q.items, ...q.assumptions.flatMap(a => a.item ? [a.item] : [])].find(i => i.post === post)!;
    // No stairwells in this list: spaces per stairwell fall back to the two buildings stated in the text.
    expect(model.counts.stairwells).toBe(0);
    expect(row('Uttag källargångar')).toMatchObject({ level: 'Antagen', quantity: '2' }); expect(row('Uttag källargångar').rule).toMatch(/antaget en källargång per huskropp/);
    expect(row('CEE-uttag teknikrum')).toMatchObject({ level: 'Antagen', quantity: '2' }); expect(row('CEE-uttag teknikrum').rule).toMatch(/antaget en teknikrum per huskropp/);
    expect(row('Belysning lägenhetsförråd')).toMatchObject({ level: 'Antagen', quantity: '6' });
    expect(row('Matning dörrautomatik')).toMatchObject({ level: 'Antagen', quantity: '2' });
    expect([...q.items, ...q.assumptions.flatMap(a => a.item ? [a.item] : [])].every(i => Number(i.quantity) > 0)).toBe(true);
  });
  it('different quantities for the same delivery are not hidden: the highest is used and the requirement needs clarification', () => {
    const q = build([golvA, { ...golvB, per_unit: 2 }]);
    const row = rowsOf(q).find(i => i.type_id === T.golv)!;
    expect(row.quantity).toBe('12'); expect(row.rule).toMatch(/Olika mängder i kraven \(6, 12\)/);
    expect(q.coverage?.filter(c => c.row === row.post).map(c => c.status)).toContain('Kräver avklaring');
  });
  it('a documented category without a requirement is a visible clarification; non-electrical duties are Ej relevant with the reason', () => {
    const q = build([req('Samordning BAS-U', 'post', 1, { section: 9, source: src('Rivning i lokaler.') })], [{ category: 'Kabelstegar och kanalisation', quote: '61 EL- OCH TELEKANALISATIONSSYSTEM' }]);
    expect(status(q, 'Kabelstegar och kanalisation')).toMatchObject({ status: 'Kräver avklaring' });
    expect(status(q, 'Samordning BAS-U')).toMatchObject({ status: 'Ej relevant', reason: expect.stringContaining('Totalentreprenörens') });
  });
  it('every requirement ends in a status and a row or a reason', () => {
    const input = [golvA, golvB, hiss, flakt, rivLgh, rivLokal, req('Okänd post', 'post', 1, { section: 9 })];
    const q = build(input);
    expect(q.coverage).toHaveLength(input.length);
    expect(q.coverage!.every(c => c.row || c.reason)).toBe(true);
  });
  it('the result is the same whatever the order of the answers', () => {
    const input = [golvA, hiss, rivLgh, golvB, flakt, rivLokal, req('Perilexuttag', 'kök', 1, { type_id: T.perilex, section: 2, source: src('Rivning i lägenheter.') }), req('Strömförsörjning spis', 'lägenhet', 1, { type_id: T.perilex, section: 1, source: src('Rivning i lägenheter.') })];
    const shape = (q: ReturnType<typeof build>) => JSON.stringify({ items: rowsOf(q).map(i => [i.post, i.quantity, i.type_id, i.level, i.requirement_ids]), coverage: q.coverage?.map(c => [c.requirement_id, c.status, c.row]).sort() });
    const forward = shape(build(input)), backward = shape(build([...input].reverse())), shuffled = shape(build([input[3]!, input[0]!, input[6]!, input[5]!, input[1]!, input[7]!, input[2]!, input[4]!]));
    expect(backward).toBe(forward); expect(shuffled).toBe(forward);
  });
  it('requirement ids are stable hashes of the structured identity', () => {
    expect(stableRequirementId('a|b|c')).toBe(stableRequirementId('a|b|c'));
    expect(stableRequirementId('a|b|c')).not.toBe(stableRequirementId('a|b|d'));
  });
  it('section answers are put together without deciding identity; stated object counts keep the largest, in any order', () => {
    const a = decodeRequirements({ requirements: [golvA], counts: [{ name: 'etapp', value: 4, source: src('Rivning i lokaler.') }] });
    const b = decodeRequirements({ requirements: [golvB], counts: [{ name: 'etapp', value: 6, source: src('Rivning i lokaler.') }] });
    for (const combined of [combineRequirementAnswers([a, b]), combineRequirementAnswers([b, a])]) {
      expect(combined.requirements).toHaveLength(2);
      expect(combined.counts).toEqual([b.counts[0]]);
    }
  });
  it('a requirement counted in another unit than its own quote states is kept for clarification, not guessed', () => {
    const q = build([req('Huvudledning lägenhet (stigarledning)', 'lägenhet', 1, { type_id: T.feed, work: 'stigarledning', section: 1, source: src('Nya stigarledningar i varje trapphus.') })]);
    expect(rowsOf(q).find(i => /stigarledning/.test(i.post))).toMatchObject({ level: 'Saknar mängd', quantity: '0' });
    expect(status(q, 'Huvudledning lägenhet (stigarledning)')).toMatchObject({ status: 'Kräver avklaring', reason: expect.stringContaining('per trapphus') });
  });
  it('stages numbered in the documents are counted in code, whatever number the model states', () => {
    const input = decodeRequirements({ requirements: [req('Byggström', 'etapp', 1, { type_id: T.bygg, section: 9, source: src('Entreprenaden indelas i följande etapper.') })], counts: [{ name: 'etapp', value: 4, source: src('Entreprenaden indelas i följande etapper.') }] });
    const q = buildRequirementQuantities(input, model, documents, exampleRoomRecipes, null, catalog);
    expect(rowsOf(q).find(i => i.type_id === T.bygg)).toMatchObject({ quantity: '3', level: 'Bekräftad' });
  });
  it('work the catalog prices with another kind\'s type is bound to that type, whichever type the model named', () => {
    const q = build([req('Strömförsörjning kombimaskin, badrum', 'badrum', 1, { type_id: T.u16, section: 3, source: src('Elektrisk golvvärme i samtliga badrum.') }),
      req('Vägguttag 16A för ugn', 'kök', 1, { type_id: T.u16, section: 2, source: src('Rivning i lägenheter.') })]);
    expect(rowsOf(q).find(i => /kombimaskin/.test(i.post))?.type_id).toBe(T.ip44);
    expect(rowsOf(q).filter(i => i.type_id === T.u16)).toHaveLength(1);
  });
  it('one delivery described twice in other words on a general or package type is one row (no double count across answers)', () => {
    const q = build([req('Uttag kombimaskin badrum', 'badrum', 1, { type_id: T.ip44, work: 'uttag', section: 3, source: src('Elektrisk golvvärme i samtliga badrum.') }),
      req('Vägguttag för kombimaskin i badrum', 'badrum', 1, { type_id: T.ip44, work: 'kombimaskin', section: 3, source: src('Elektrisk golvvärme i samtliga badrum.') }),
      req('Separat WC: belysning', 'wc', 1, { type_id: T.wc, work: 'belysning', section: 3, source: src('Elektrisk golvvärme i samtliga badrum.') }),
      req('Spegelskåp i separat wc', 'wc', 1, { type_id: T.wc, work: 'spegelskåp', section: 3, source: src('Elektrisk golvvärme i samtliga badrum.') })]);
    expect(rowsOf(q).filter(i => i.type_id === T.ip44 && Number(i.quantity) > 0)).toHaveLength(1);
    expect(rowsOf(q).filter(i => i.type_id === T.wc)).toHaveLength(1);
  });
  it('a per-apartment requirement on a catalog type for apartment work is counted, even when the model calls it assumed', () => {
    const q = build([req('Anslutning spis/ugn', 'lägenhet', 1, { type_id: T.spis, assumed: true, section: 2, source: src('Matning till fläktar.') })]);
    expect(rowsOf(q).find(i => /spis/.test(i.post))).toMatchObject({ quantity: '6', type_id: T.perilex });
  });
  it('a section answer that leaves several documented categories of its own sections unlisted is asked again', () => {
    const tech = { id: pdf, file_name: 'El.pdf', file_type: 'pdf', page_count: 1, text: 'Fysisk sida: 1\nElektrisk golvvärme i samtliga badrum.\nElektrisk handdukstork i samtliga badrum.\nPerilexuttag för spis i köket.\nDiskmaskin ansluts i köket.\nDimmer i vardagsrum.' };
    const fullCatalog = [...catalog, { id: '00000000-0000-4000-8000-000000000510', name: 'Handdukstork anslutning' }, { id: '00000000-0000-4000-8000-000000000511', name: 'Diskmaskin anslutning' }, { id: '00000000-0000-4000-8000-000000000512', name: 'Dimmer' }];
    const empty = decodeRequirements({ requirements: [], counts: [] });
    expect(thinSectionGroups([documents[0]!, tech], [empty, empty, empty], REQUIREMENT_SECTION_GROUPS, fullCatalog).map(g => g.join(','))).toEqual(['1,2,3,4']);
    const listed = decodeRequirements({ requirements: [golvA, req('Handdukstork', 'badrum', 1, { section: 3 }), req('Perilexuttag spis', 'kök', 1, { section: 2 }), req('Diskmaskin', 'kök', 1, { section: 2 })], counts: [] });
    expect(thinSectionGroups([documents[0]!, tech], [listed, empty, empty], REQUIREMENT_SECTION_GROUPS, fullCatalog)).toEqual([]);
  });
  it('work at the worktop that is not a socket is counted per kitchen, never folded into the counter-socket recipe', () => {
    for (const unit of ['bänklängd', 'kök'] as const) {
      const q = build([req('Armatur L2 ovan arbetsbänk', unit, unit === 'kök' ? 1 : null, { type_id: T.bank, section: 2, source: src('Rivning i lägenheter.'), note: '1st hörnbox per arbetsbänk vars längd överstiger 400mm' }),
        req('Bänkuttag kök', 'bänklängd', null, { section: 2, source: src('Rivning i lägenheter.') })]);
      expect(rowsOf(q).find(i => /L2/.test(i.post))).toMatchObject({ quantity: '6', type_id: T.bank });
      expect(status(q, 'Armatur L2 ovan arbetsbänk')?.status).not.toBe('Ingår i annan post');
      expect(status(q, 'Bänkuttag kök')).toMatchObject({ status: 'Ingår i annan post', row: 'Bänkuttag kök enligt typrecept' });
    }
  });
  it('Baggen export errors, in general form: per-apartment numbers, premises posts, sections and the catalog type by meaning', () => {
    const cat = [...catalog, { id: '00000000-0000-4000-8000-000000000521', name: 'Lampstickpropp med LED' }, { id: '00000000-0000-4000-8000-000000000522', name: 'Huvudledning lokal' },
      { id: '00000000-0000-4000-8000-000000000523', name: 'Brandvarnare' }, { id: '00000000-0000-4000-8000-000000000524', name: 'Dubbelt vägguttag' }, { id: '00000000-0000-4000-8000-000000000525', name: 'Styrning fasadbelysning' }];
    const docs = [...documents.slice(0, 2), { ...documents[1]!, id: '00000000-0000-4000-8000-000000000004', file_name: 'El2.pdf', text: 'Fysisk sida: 1\nLamputtag skall vara DCL och till 2st lamputtag per lägenhet skall lampstickpropp med E27 levereras.\nNya huvudledningar till samtliga lägenhets, lokaler och fastighetscentraler.\nSamtliga lägenheter förses med mätare för debiteringsmätning.\nStäduttag monteras, 1st per trapphus.\nInom lägenheter monteras brandvarnare, en per 60m2.' }];
    const s2 = (evidence: string) => ({ document_id: '00000000-0000-4000-8000-000000000004', page: 1, evidence });
    const q = buildRequirementQuantities(decodeRequirements({ requirements: [
      req('Lampstickpropp med LED', 'fast_antal', null, { fixed_quantity: 2, type_id: cat[10]!.id, section: 4, source: s2('Lamputtag skall vara DCL och till 2st lamputtag per lägenhet skall lampstickpropp med E27 levereras.') }),
      req('Huvudledning lokal', 'lokal', 1, { type_id: cat[11]!.id, section: 5, source: s2('Nya huvudledningar till samtliga lägenhets, lokaler och fastighetscentraler.') }),
      req('Mätare för lokal', 'lokal', 1, { section: 5, source: s2('Samtliga lägenheter förses med mätare för debiteringsmätning.') }),
      req('Brandvarnare', 'per_area', 1, { area_divisor: 60, type_id: cat[12]!.id, section: 5, source: s2('Inom lägenheter monteras brandvarnare, en per 60m2.') }),
      req('Städuttag trapphus', 'trapphus', 1, { type_id: 'okänd', section: 6, source: s2('Städuttag monteras, 1st per trapphus.') }),
      req('Fasadarmaturer vid entréer', 'fast_antal', null, { fixed_quantity: 4, section: 6, source: s2('Städuttag monteras, 1st per trapphus.') }),
    ], counts: [{ name: 'trapphus', value: 4, source: s2('Städuttag monteras, 1st per trapphus.') }] }), model, docs, exampleRoomRecipes, null, cat);
    const row = (post: string) => [...q.items, ...q.assumptions.flatMap(a => a.item ? [a.item] : [])].find(i => i.post === post)!;
    // "2st ... per lägenhet" is 2 × the apartments, whatever unit the model named.
    expect(row('Lampstickpropp med LED')).toMatchObject({ quantity: '12', count_unit: 'lägenhet' });
    // Premises posts use the premises in the object list (2 here); a quote naming premises is no conflict.
    expect(row('Huvudledning lokal')).toMatchObject({ quantity: '2', level: 'Bekräftad' });
    expect(row('Mätare för lokal')).toMatchObject({ quantity: '2', level: 'Antagen' }); expect(status(q, 'Mätare för lokal')?.status).toBe('Kräver avklaring');
    // The section follows the unit: smoke detectors per apartment area are apartment work, not premises.
    expect(row('Brandvarnare').section).toBeLessThanOrEqual(4);
    // A documented post without a valid catalog type is bound by its own meaning; a type of another kind of work is not used.
    expect(row('Städuttag trapphus').type_id).toBe(cat[13]!.id);
    expect(row('Fasadarmaturer vid entréer').type_id).toBeNull();
  });
  it('a property-level unit for work whose quote states apartments and premises joins that delivery instead of a second row', () => {
    const tom = '00000000-0000-4000-8000-000000000531', hc = '00000000-0000-4000-8000-000000000532', hl = '00000000-0000-4000-8000-000000000533';
    const cat = [...catalog, { id: tom, name: 'Tomrör för framtida mätning' }, { id: hc, name: 'Huvudledning fastighetscentral' }, { id: hl, name: 'Huvudledning lägenhet' }];
    const quote = 'Tomrör och BUS ledning för framtida mätning av vattenförbrukning i respektive lägenhet och lokaler.', feeds = 'Nya huvudledningar till samtliga lägenhets, lokaler och fastighetscentraler.';
    const docs = [...documents.slice(0, 2), { ...documents[1]!, id: '00000000-0000-4000-8000-000000000005', file_name: 'El3.pdf', text: `Fysisk sida: 1\n${quote}\n${feeds}` }];
    const s3 = (evidence: string) => ({ document_id: '00000000-0000-4000-8000-000000000005', page: 1, evidence });
    const q = buildRequirementQuantities(decodeRequirements({ requirements: [
      req('Tomrör lägenhet', 'lägenhet', 1, { type_id: tom, section: 1, source: s3(quote) }),
      req('Tomrör lägenheter och lokaler', 'lägenhet_och_lokal', 1, { type_id: tom, section: 7, source: s3(quote) }),
      req('Tomrör (lgh och lokaler)', 'fastighet', 1, { type_id: tom, section: 7, source: s3(quote) }),
      req('Huvudledning lägenhet', 'lägenhet', 1, { type_id: hl, section: 1, source: s3(feeds) }),
      req('Huvudledning fastighetscentral', 'huskropp', 1, { type_id: hc, section: 7, source: s3(feeds) }),
    ], counts: [{ name: 'huskropp', value: 2, source: s3(feeds) }] }), model, docs, exampleRoomRecipes, null, cat);
    const all = [...q.items, ...q.assumptions.flatMap(a => a.item ? [a.item] : [])];
    // Two rows for the tubes (per apartment, and apartments and premises), not a third per property.
    expect(all.filter(i => i.type_id === tom).map(i => i.count_unit).sort()).toEqual(['lägenhet', 'lägenhet_och_lokal']);
    // A property central's feed stays per building although the quote also names the apartments.
    expect(all.find(i => i.type_id === hc)).toMatchObject({ count_unit: 'huskropp', quantity: '2' });
  });
  it('the same delivery at property level is one row, whatever place the model names', () => {
    const q = build([req('Ny fastighetscentral', 'fastighet', null, { fixed_quantity: 2, type_id: T.riv, scope: 'fastighet', section: 7, source: src('Matning till hiss.') }),
      req('Fastighetscentral i elrum', 'fastighet', null, { fixed_quantity: 2, type_id: T.riv, scope: 'tekniska_utrymmen', section: 7, source: src('Matning till hiss.') })]);
    expect(rowsOf(q).filter(i => i.type_id === T.riv)).toHaveLength(1);
  });
  it('the same work in different named spaces is one delivery per space, each with its own quote', () => {
    const q = build([req('LED-armatur lägenhetsförråd och källargångar', 'fastighet', null, { fixed_quantity: 1, type_id: T.riv, scope: 'källare', section: 6, source: src('Lägenhetsförråd och källargångar Nya armaturer monteras i tak') }),
      req('Belysning tekniska utrymmen', 'fastighet', null, { fixed_quantity: 1, type_id: T.riv, scope: 'tekniska_utrymmen', section: 6, source: src('Tekniska utrymmen Ny belysningsinstallation') })]);
    expect(rowsOf(q).filter(i => i.type_id === T.riv).map(i => i.post).sort()).toEqual(['Belysning tekniska utrymmen', 'LED-armatur lägenhetsförråd och källargångar']);
  });
  it('work of other trades is never a calculation row or a warning; electrical work at the same place stays', () => {
    const q = build([req('Hatthylla med infästning hall', 'lägenhet', 1, { section: 4, source: src('Ny hatthylla monteras i hall, Essem Nostalgi krom/alu inkl. 3st ankarkrokar.') }),
      req('Skohylla och klädstång', 'fast_antal', null, { fixed_quantity: 82, section: 4, source: null }),
      req('Uttag vid hatthylla', 'lägenhet', 1, { section: 4, source: src('Vägguttag monteras vid hatthylla i hall.') })]);
    expect(rowsOf(q).map(i => i.post)).not.toContain('Hatthylla med infästning hall');
    expect(rowsOf(q).map(i => i.post)).not.toContain('Skohylla och klädstång');
    expect(rowsOf(q).map(i => i.post)).toContain('Uttag vid hatthylla');
    expect(status(q, 'Hatthylla med infästning hall')).toMatchObject({ status: 'Ej relevant' });
    expect(q.assumptions.some(a => /annan yrkesgrupps arbete\): Hatthylla med infästning hall, Skohylla och klädstång/.test(a.description))).toBe(true);
  });
});
