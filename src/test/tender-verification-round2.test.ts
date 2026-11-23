import { describe, expect, it } from 'vitest';
import { typeCodesInText } from '@/lib/tender-type-codes';
import { buildObjectModel } from '@/lib/tender-object-model';
import { buildRequirementQuantities, decodeRequirements, type Requirement } from '@/lib/tender-requirements';
import { exampleRoomRecipes } from '@/lib/tender-room-recipes';
import { calculateTenderCost, emptyCalculationSettings } from '@/lib/tender-calculation';
import { correctedScopeType, postMeaning } from '@/lib/tender-post-matching';

// Synthetic object list (no customer data): 12 apartments over 2 addresses, 2 premises.
const xlsx = '00000000-0000-4000-8000-000000000001', pdf = '00000000-0000-4000-8000-000000000002';
const lines = ['Blad: Objekt', 'A1: Objekt\tB1: Objektstyp\tC1: Lägenhetsnr\tD1: Area\tE1: Adress\tF1: Plan'];
const types = ['1 rum o kokvrå', '2 rum o kök', '3 rum o kök', '3.5 rum o kök', '4 rum o kök', '4 rum o kök'];
let row = 2;
for (const address of ['Gata 1', 'Gata 3']) for (let i = 0; i < 6; i++) { lines.push(`A${row}: O${row}\tB${row}: ${types[i]}\tC${row}: ${address === 'Gata 1' ? 1100 + i : 2100 + i}\tD${row}: ${[38, 62, 81, 95, 97, 116][i]}\tE${row}: ${address}\tF${row}: ${1 + (i % 3)}`); row++; }
lines.push(`A${row}: L1\tB${row}: Lokal\tC${row}: 9001\tD${row}: 150\tE${row}: Gata 1\tF${row}: BV`, `A${row + 1}: L2\tB${row + 1}: Lokal\tC${row + 1}: 9002\tD${row + 1}: 90\tE${row + 1}: Gata 3\tF${row + 1}: BV`);
const documents = [{ id: xlsx, file_name: 'Objekt.xlsx', file_type: 'xlsx', page_count: null, text: lines.join('\n') }, { id: pdf, file_name: 'El.pdf', file_type: 'pdf', page_count: 1, text: 'Fysisk sida: 1\nEl.' }];
// Drawing transcribed as a schedule: bare area cells, and a code on its own line between room labels.
const drawing = ['| Lgh | Typ | BOA |', '| 2105 | L4+U-K14-B12-W2-K16-B13 | 116 |', 'L4-K2-B4-W1', 'SOVRUM 12 m²', 'BOA 97 m²'].join('\n');
const req = (post: string, unit_of_count: Requirement['unit_of_count'], per_unit: number | null, extra: Partial<Requirement> = {}): Requirement => ({ post, section: 3, unit_of_count, per_unit, fixed_quantity: null, area_divisor: null, unit: 'st', assumed: false, note: null, source: null, ...extra });
const model = buildObjectModel(documents, typeCodesInText(drawing), null);
const build = (requirements: Requirement[]) => buildRequirementQuantities(decodeRequirements({ requirements, counts: [] }), model, documents, exampleRoomRecipes);
const all = (q: ReturnType<typeof build>) => [...q.items, ...q.assumptions.flatMap(a => a.item ? [a.item] : [])];
const quantity = (q: ReturnType<typeof build>, post: string) => all(q).find(i => i.post === post)?.quantity;

describe('verification round 2', () => {
  it('links type codes to the list through candidates that exist in it, not a room area', () => {
    expect(model?.code_matches).toBe(4); // 2105 by number; 1105 and 2105 by area 116; 1104 and 2104 by area 97 (one counted per apartment)
    expect(model?.counts).toMatchObject({ kitchens: 14, bathrooms: 14 });
  });
  it('an area divisor stated per apartment counts started areas; a stated fixed quantity is always used', () => {
    const q = build([req('Brandvarnare', 'lägenhet', 1, { area_divisor: 60, section: 4 }), req('Laddplatser i garage', 'fastighet', null, { fixed_quantity: 8, section: 6 })]);
    expect(quantity(q, 'Brandvarnare')).toBe(String(2 * [38, 62, 81, 95, 97, 116].reduce((s, a) => s + Math.ceil(a / 60), 0)));
    expect(quantity(q, 'Laddplatser i garage')).toBe('8');
  });
  it('merges overlapping requirements for the same equipment and unit, never generic feeds', () => {
    const q = build([req('Strömförsörjning spis/ugn i lägenhet', 'lägenhet', 1, { section: 1 }), req('Perilexuttag för spishäll', 'kök', 1, { section: 2 }), req('Projektering el', 'post', 1, { section: 9 }), req('Upprättande av bygghandlingar', 'post', 1, { section: 9 }),
      req('Matning till fjärrvärmecentral', 'fastighet', 1, { section: 7 }), req('Ny matning till styrskåp för markvärme', 'fastighet', 1, { section: 7 })]);
    const posts = all(q).map(i => i.post);
    expect(posts).toContain('Perilexuttag för spishäll'); expect(posts).not.toContain('Strömförsörjning spis/ugn i lägenhet');
    expect(quantity(q, 'Perilexuttag för spishäll')).toBe('14');
    expect(posts).toContain('Projektering el'); expect(posts).not.toContain('Upprättande av bygghandlingar');
    expect(posts).toEqual(expect.arrayContaining(['Matning till fjärrvärmecentral', 'Ny matning till styrskåp för markvärme']));
    expect(q.assumptions.map(a => a.description)).toContainEqual(expect.stringContaining('Strömförsörjning spis/ugn i lägenhet ingår i Perilexuttag för spishäll'));
  });
  it('a washing-machine supply is per apartment, even when stated per bathroom', () => {
    expect(quantity(build([req('Strömförsörjning kombimaskin i badrum', 'badrum', 1)]), 'Strömförsörjning kombimaskin i badrum')).toBe('12');
  });
  it('training of operating staff is training, not the O&M binder', () => expect(postMeaning('Utbildning av drift- och underhållspersonal')).toBe('utbildning'));
  const ids = { tork: '00000000-0000-4000-8000-000000000011', provning: '00000000-0000-4000-8000-000000000012', hal: '00000000-0000-4000-8000-000000000013' };
  const settings = { ...emptyCalculationSettings, hourly_rate: 600, post_types: [{ id: ids.tork, name: 'Handdukstork anslutning', hours: 1, list_price: 4000 }, { id: ids.provning, name: 'Provning allmänna delar', hours: 24, list_price: 0 }, { id: ids.hal, name: 'Håltagning och brandtätning per lägenhet', hours: 2, list_price: 300 }] };
  it('an option is its own unpriced row unless given its own time or price', () => {
    const q = build([req('Elektrisk handdukstork', 'badrum', 1), req('Option timer på handdukstork', 'badrum', 1, { note: 'Option enligt underlag' })]);
    expect(all(q).find(i => i.post === 'Option timer på handdukstork')).toMatchObject({ option: true });
    const bindings = all(q).map(i => ({ post: i.post, type_id: /handdukstork/i.test(i.post) ? ids.tork : null, manual_hours: null, manual_list_price: null }));
    const cost = calculateTenderCost(q, settings, { bindings, demolition: null });
    expect(cost.rows.find(r => r.post === 'Option timer på handdukstork')).toMatchObject({ level: 'Saknar pris', total: null });
    expect(cost.rows.find(r => r.post === 'Elektrisk handdukstork')?.total).toBeGreaterThan(0);
    const priced = calculateTenderCost(q, settings, { bindings: bindings.map(b => b.post.startsWith('Option') ? { ...b, manual_list_price: 500 } : b), demolition: null });
    expect(priced.rows.find(r => r.post === 'Option timer på handdukstork')?.total).toBeGreaterThan(0);
  });
  it('one-off posts bound to the same catalog type count once; a per-apartment catalog type counts apartments', () => {
    const q = build([req('Relationshandlingar el', 'post', 1, { section: 9 }), req('Relationsritningar el', 'post', 1, { section: 9 }), req('Håltagning och tätning', 'post', 1, { section: 8 })]);
    const bindings = all(q).map(i => ({ post: i.post, type_id: /håltagning/i.test(i.post) ? ids.hal : ids.provning, manual_hours: null, manual_list_price: null }));
    const rows = calculateTenderCost(q, settings, { bindings, demolition: null }).rows;
    expect(rows.find(r => r.post === 'Relationshandlingar el')?.quantity).toBe('1');
    expect(rows.find(r => r.post === 'Relationsritningar el')).toMatchObject({ quantity: '0', total: 0, rule: expect.stringContaining('Ingår i Relationshandlingar el') });
    expect(rows.find(r => r.post === 'Håltagning och tätning')).toMatchObject({ quantity: '12', level: 'Antagen' });
  });
  it('insulation measurement is the test per apartment (reference 9.3), never merged into the common-parts test', () => {
    expect(postMeaning('Isolationsmätning, jordning och jordfelsbrytartest')).toBe('provning-lgh');
    const q = build([req('Samordnad funktionsprovning', 'post', 1, { section: 9 }), req('Isolationsmätning, jordning och jordfelsbrytartest', 'post', 1, { section: 9 })]);
    expect(quantity(q, 'Samordnad funktionsprovning')).toBe('1');
    expect(all(q).find(i => i.post.startsWith('Isolationsmätning'))).toMatchObject({ quantity: '12', count_unit: 'lägenhet' });
    // A binding of the right kind but the wrong scope moves to the catalog type of the post's own scope.
    const catalog = { ...settings, post_types: [...settings.post_types, { id: '00000000-0000-4000-8000-000000000014', name: 'Provning och protokoll per lägenhet', hours: 1, list_price: 0 }] };
    expect(correctedScopeType('Isolationsmätning, jordning och jordfelsbrytartest', ids.provning, catalog)).toBe('00000000-0000-4000-8000-000000000014');
    expect(correctedScopeType('Samordnad funktionsprovning', ids.provning, catalog)).toBe(ids.provning);
    expect(correctedScopeType('Isolationsmätning', ids.provning, settings)).toBe(ids.provning);
  });
});
