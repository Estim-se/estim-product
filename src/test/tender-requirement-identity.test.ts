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
  it('a missing quantity is Saknar mängd and a missing source is flagged', () => {
    const q = build([req('Belysning källare', 'fastighet', null, { type_id: T.feed, work: 'belysning källare', section: 6, source: src('Matning till fläktar.') }), req('Golvvärme', 'badrum', 1, { type_id: T.golv })]);
    expect(status(q, 'Belysning källare')?.status).toBe('Saknar mängd');
    expect(status(q, 'Golvvärme')).toMatchObject({ status: 'Antagen', validation: ['källa saknas'] });
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
  it('the same delivery at property level is one row, whatever place the model names', () => {
    const q = build([req('Ny fastighetscentral', 'fastighet', null, { fixed_quantity: 2, type_id: T.riv, scope: 'fastighet', section: 7, source: src('Matning till hiss.') }),
      req('Fastighetscentral i elrum', 'fastighet', null, { fixed_quantity: 2, type_id: T.riv, scope: 'tekniska_utrymmen', section: 7, source: src('Matning till hiss.') })]);
    expect(rowsOf(q).filter(i => i.type_id === T.riv)).toHaveLength(1);
  });
});
