import { describe, expect, it } from 'vitest';
import type { QuantityItem } from '@/lib/tender-quantities';
import { V2_POSTS, V2_TOTAL, V2_COUNTS, V2_RISKS, V2_QUESTIONS } from './helpers/v2-baggen';
import { compareWithV2, formatV2Comparison, v2PostFor } from './helpers/v2-comparison';

const item = (post: string, quantity: number | null, certainty: QuantityItem['certainty'] = 'Hög'): QuantityItem => ({ post, unit: 'st', quantity: String(quantity ?? 0), calculation: '', rule: '', sources: [], certainty });
const snapshot = (items: QuantityItem[]) => ({ quantities: { rules: { operands: [], items: [], assumptions: [] }, items, assumptions: [] } });

describe('v2 fasit', () => {
  it('reproduces the v2 totals from its posts and example prices', () => {
    const c = compareWithV2(snapshot(V2_POSTS.map(p => item(p.post, p.quantity, p.quantity === null ? 'Låg' : 'Hög'))));
    expect(c.at_v2_prices.base).toBe(V2_TOTAL.base);
    expect(c.at_v2_prices.total).toBe(V2_TOTAL.total);
  });
  it('has 70 posts in 9 sections with the v2 certainty distribution', () => {
    expect(V2_POSTS).toHaveLength(70);
    expect(new Set(V2_POSTS.map(p => p.section)).size).toBe(9);
    const by = (c: string) => V2_POSTS.filter(p => p.certainty === c).length;
    expect([by('Bekräftad'), by('Räknad'), by('Antagen'), by('Saknar mängd'), by('Saknar pris')]).toEqual([25, 22, 19, 3, 1]);
    expect(V2_COUNTS).toMatchObject({ apartments: 82, kitchens: 83, bathrooms: 87, separate_wc: 39, bedrooms_and_half_rooms: 169 });
    expect(V2_RISKS).toHaveLength(11); expect(V2_QUESTIONS).toHaveLength(10);
  });
  it('holds no customer data: no addresses, object or apartment numbers, names', () => {
    const text = JSON.stringify({ posts: V2_POSTS.map(p => p.post), risks: V2_RISKS, questions: V2_QUESTIONS });
    expect(text).not.toMatch(/gatan|\b\d{5}-\d+|\blgh\s*\d{3,4}\b|ellevio|volt|baggen/i);
  });
  it('every v2 post is matched by its own name', () => {
    for (const p of V2_POSTS) expect(v2PostFor(p.post)?.nr, p.post).toBe(p.nr);
  });
});

describe('comparison', () => {
  it('a result equal to v2 is complete: 67 right, 3 flagged as missing quantity, 0 missing', () => {
    const c = compareWithV2(snapshot(V2_POSTS.map(p => item(p.post, p.quantity, p.quantity === null ? 'Låg' : 'Hög'))));
    expect(c.counts).toMatchObject({ 'rätt': 67, 'flaggad': 3, 'saknas': 0, 'fel': 0 });
    expect(c.found).toBe(70); expect(c.extras).toHaveLength(0);
  });
  it.each([
    ['Dubbla vägguttag sovrum enligt typrecept', '4.7'], ['Dubbla vägguttag halvrum enligt typrecept', '4.7'], ['Lamputtag hall enligt typrecept', '4.3'],
    ['Lamputtag sovrum enligt typrecept', '4.1'], ['Bänkuttag kök enligt typrecept', '2.7'], ['Kök – hörnbox/vägguttag enligt typrecept', '2.7'],
    ['Brandvarnare', '4.9'], ['Lägenhetscentral', '1.4'], ['Nya centraler i lokaler', '5.1'], ['Uttag diskmaskin', '2.3'], ['Takuttag kök', '2.10'],
    ['Spotlights IP44', '3.1'], ['Dubbelt uttag IP44', '3.5'], ['Armatur L2 ovan arbetsbänk i kök', '2.9'], ['Elektrisk golvvärme i badrum', '3.3'],
    ['Märkning: graverade skyltar och gruppförteckningar', '9.5'], ['Matning hiss', '7.7'], ['Provning och dokumentation', '9.4'],
    ['Huvudledning lägenhet', '1.6'], ['Huvudledning lokal', '5.2'], ['Rivning per lägenhet', '1.2'], ['Servisledning', '7.2'],
  ])('maps the pipeline post "%s" to v2 %s', (post, nr) => expect(v2PostFor(post)?.nr).toBe(nr));
  it('reports posts that v2 does not have, e.g. demolition per premises', () => {
    const c = compareWithV2(snapshot([item('Rivning befintlig elinstallation per lokal', 9), item('Datauttag', 164)]));
    expect(c.extras.map(r => r.post)).toEqual(['Rivning befintlig elinstallation per lokal', 'Datauttag']);
  });
  it('sums several pipeline posts for one v2 post and grades the quantity', () => {
    const c = compareWithV2(snapshot([item('Dubbla vägguttag sovrum enligt typrecept', 426), item('Dubbla vägguttag halvrum enligt typrecept', 81), item('Bänkuttag kök enligt typrecept', 246), item('Elektrisk golvvärme i badrum', 82)]));
    const status = (nr: string) => c.lines.find(l => l.v2.nr === nr)?.status;
    expect([status('4.7'), status('2.7'), status('3.3'), status('1.1')]).toEqual(['rätt', 'nära', 'fel', 'saknas']);
    expect(formatV2Comparison(c)).toMatch(/Sammanfattning: 3\/70 v2-poster hittade/);
  });
  it('marks whether a post is inside the total when cost rows are given', () => {
    const c = compareWithV2({ ...snapshot([item('Brandvarnare', 150), item('Golvvärme', 87, 'Låg')]), cost: { rows: [{ post: 'Brandvarnare', total: 59437.5 }], proposals: [{ post: 'Golvvärme', total: null }], total: 59437.5 } });
    expect(c.lines.find(l => l.v2.nr === '4.9')?.in_total).toBe('med');
    expect(c.lines.find(l => l.v2.nr === '3.3')?.in_total).toBe('utanför');
  });
});
