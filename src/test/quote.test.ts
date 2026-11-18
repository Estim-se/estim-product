import { describe, expect, it } from 'vitest';
import { initialThreads } from '@/data/inbox';
import { calc, calcAdd, type Quote } from '@/lib/quote';
import { DRAFTS } from '@/lib/drafts';

const quote = (owners = 1): Quote => ({ nr: 'test', owners, addOn: false, prisform: 'fast', lines: [{ t: 'Work', typ: 'arbete', q: 1, u: 'h', p: 1000, rot: true }] });
describe('Exact prototype money rules', () => {
  it('adds 25% VAT', () => { expect(calc(quote()).inkl).toBe(1250); expect(calc(quote()).moms).toBe(250); });
  it('deducts 30% ROT from VAT-inclusive eligible work only', () => { const q = quote(); q.lines.push({ t: 'Material', typ: 'material', q: 1, u: 'st', p: 1000, rot: true }); expect(calc(q).av).toBe(375); expect(calc(q).betala).toBe(2125); });
  it('caps ROT at 50 000 kr per owner', () => { const q = quote(2); const line = q.lines[0]; if (!line) throw new Error('Missing line'); line.p = 1000000; expect(calc(q).av).toBe(100000); q.owners = 1; expect(calc(q).av).toBe(50000); });
  it('rounds VAT-inclusive total and deduction separately', () => { const q = quote(); const line = q.lines[0]; if (!line) throw new Error('Missing line'); line.p = 101; expect(calc(q).inkl).toBe(126); expect(calc(q).av).toBe(38); expect(calc(q).betala).toBe(88); });
  it('includes optional lines only when selected', () => { const q = quote(); q.lines.push({ t: 'Optional', typ: 'arbete', q: 1, u: 'h', p: 1000, rot: true, opt: true }); expect(calc(q, false).betala).toBe(875); expect(calc(q, true).betala).toBe(1750); expect(calcAdd(q).betala).toBe(875); });
  it('keeps all generated amounts tied to current quote data', () => { const t = initialThreads().find(t => t.id === 'lind'); if (!t?.q) throw new Error('Missing quote'); expect(calc(t.q, false).betala).toBe(28962); expect(calcAdd(t.q).inkl).toBe(9313); const old = DRAFTS.lind(t); const line = t.q.lines[0]; if (!line) throw new Error('Missing line'); line.p = 1300; expect(DRAFTS.lind(t)).not.toBe(old); });
});