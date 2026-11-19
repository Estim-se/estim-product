import { describe, expect, it } from 'vitest';
import { buildReview, existingDuplicates, fileProblem, isOld, MAX_FILES, newRowClashes, toPayload, type FileResult } from '@/lib/price-import';

const now = new Date('2026-11-19');
const item = (description: string, price: number, extra: Partial<FileResult['items'][number]> = {}) => ({
  description, quantity: 1, unit: 'st', unit_price_ex_vat: price, typ: 'material' as const, role: null, rot: false,
  source: { file: 'a.pdf', page: 1, row: 1 }, date: '2026-09-01', ...extra });
const moments = [
  { id: 'm1', name: 'Spotlight, montering', unit: 'st', hours_per_unit: 0.5, material_per_unit_ex_vat: 200, role: 'elektriker', rot_eligible: true },
  { id: 'm2', name: 'Spotlight montering', unit: 'st', hours_per_unit: 0.5, material_per_unit_ex_vat: 200, role: 'elektriker', rot_eligible: true },
  { id: 'm3', name: 'Byte till jordat uttag', unit: 'st', hours_per_unit: 1, material_per_unit_ex_vat: 150, role: 'elektriker', rot_eligible: true },
];

describe('price import rules', () => {
  it('allows at most 30 files', () => expect(MAX_FILES).toBe(30));
  it('accepts only PDF, JPG and PNG up to 15 MB', () => {
    expect(fileProblem({ type: 'application/pdf', size: 1000 })).toBeNull();
    expect(fileProblem({ type: 'image/gif', size: 1000 })).not.toBeNull();
    expect(fileProblem({ type: 'image/png', size: 16 * 1024 * 1024 })).not.toBeNull();
  });
  it('marks prices older than 18 months', () => {
    expect(isOld('2025-04-01', now)).toBe(true);
    expect(isOld('2025-07-01', now)).toBe(false);
  });
  it('treats "Installation av spotlight" and "Spotlight, montering" as duplicates', () => {
    expect(existingDuplicates([{ ...moments[0]!, name: 'Installation av spotlight' }, moments[0]!]).length).toBe(1);
  });
  it('warns about duplicate existing moments', () => {
    expect(existingDuplicates(moments).map((g) => g.length)).toEqual([2]);
  });
  it('suggests updating an existing similar moment and keeps the source', () => {
    const rows = buildReview([{ file: 'a.pdf', path: 'c/a.pdf', items: [item('Jordat uttag, byte', 180)] }], moments, 650, now);
    expect(rows[0]!.mode).toBe('update');
    expect(rows[0]!.targetId).toBe('m3');
    const p = toPayload(rows, null, ['c/a.pdf']);
    expect(p.moments[0]!.source[0]).toMatchObject({ file: 'a.pdf', path: 'c/a.pdf', page: 1, row: 1, price: 180 });
  });
  it('marks outliers more than 30 % from similar lines', () => {
    const rows = buildReview([{ file: 'a.pdf', path: 'p', items: [item('Dimmer LED', 300), item('Dimmer LED', 310), item('Dimmer LED', 600)] }], [], 650, now);
    expect(rows.map((r) => r.outlier)).toEqual([false, false, true]);
  });
  it('saves nothing that was skipped', () => {
    const rows = buildReview([{ file: 'a.pdf', path: 'p', items: [item('Kabel', 20)] }], [], 650, now);
    rows[0]!.decision = 'skip';
    expect(toPayload(rows, null, []).moments).toEqual([]);
  });
  it('flags new moments that clash with existing ones', () => {
    const rows = buildReview([{ file: 'a.pdf', path: 'p', items: [item('Spotlight montering', 250)] }], moments, 650, now);
    rows[0]!.mode = 'new';
    expect(newRowClashes(rows, moments).size).toBe(1);
  });
});
