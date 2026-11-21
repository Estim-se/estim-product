import { expect, it } from 'vitest';
import { resolveObjectCount } from '@/lib/tender-object-counts';
const text = 'Blad: Lägenheter\nA5: A101\tD5: 1 rok\tE5: 0\nA6: A102\tD6: 2 rok\tE6: 1\nA7: A103\tD7: 3 rok\tE7: 2';
it('counts original object rows without trusting model totals', () => { expect(resolveObjectCount(text,{sheet:'Lägenheter',range:'A5:A7',operation:'Antal',equals:null})).toBe('3'); });
it('counts distinct stairwells once, not one per apartment', () => { expect(resolveObjectCount('Blad: Lista\nB5: A\nB6: A\nB7: B',{sheet:'Lista',range:'B5:B7',operation:'Unika',equals:null})).toBe('2'); });
it('counts selected apartment types from original cells', () => { expect(resolveObjectCount(text,{sheet:'Lägenheter',range:'D5:D7',operation:'Antal',equals:'2 rok'})).toBe('1'); });
it('sums original bedroom counts, including zero-bedroom apartments', () => { expect(resolveObjectCount(text,{sheet:'Lägenheter',range:'E5:E7',operation:'Summa',equals:null})).toBe('3'); });
it('rejects nonexistent worksheets, cells and filters rather than inventing zero', () => { for (const change of [{sheet:'Missing'},{range:'A5:A8'},{equals:'5 rok'}]) expect(() => resolveObjectCount(text,{sheet:'Lägenheter',range:'A5:A7',operation:'Antal',equals:null,...change})).toThrow(); });
it('rejects ranges spanning different columns and overlarge ranges', () => { for (const range of ['A5:D7','A1:A10002','A7:A5']) expect(() => resolveObjectCount(text,{sheet:'Lägenheter',range,operation:'Antal',equals:null})).toThrow(); });