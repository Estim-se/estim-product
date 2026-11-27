import { describe, expect, it } from 'vitest';
import { LAB_AI_ALLOWED_EMAILS, isAllowedDemoUser, newBudget, reserveCall } from './ai-policy';
import { analyseFromAi, applyToRegister, type AiExtraction } from './analyze';
import { calc } from '@/lib/quote';
import { catalog, customers } from './data';

const data = { customers, catalog };
const base: AiExtraction = { business: true, summary: '', customer_name: null, address: null, spoken_phone: null, job_kind: null, new_job_title: null, is_addon: false, items: [], tasks: [] };

describe('lab AI access policy', () => {
  it('allows only the two approved demo accounts', () => {
    expect([...LAB_AI_ALLOWED_EMAILS].sort()).toEqual(['hassan@futureventures.se', 'moi-ali@hotmail.com']);
    expect(isAllowedDemoUser('Moi-Ali@hotmail.com')).toBe(true);
    expect(isAllowedDemoUser('someone@else.se')).toBe(false);
    expect(isAllowedDemoUser(undefined)).toBe(false);
  });
  it('enforces the per-user hourly limit and the total budget', () => {
    const b = newBudget();
    for (let i = 0; i < 15; i++) expect(reserveCall(b, 'u1', 1000)).toBeNull();
    expect(reserveCall(b, 'u1', 1000)).not.toBeNull();
    const t = newBudget(); t.total = 60;
    expect(reserveCall(t, 'u2', 1000)).not.toBeNull();
  });
});

describe('lab AI result handling', () => {
  it('private extraction gives no business output', () => {
    expect(analyseFromAi({ ...base, business: false }, { phone: '0701234567', type: 'in' }, data)).toEqual({ privat: true });
  });
  it('prices come from the catalog and standard material is added', () => {
    const a = analyseFromAi({ ...base, job_kind: 'badrum', items: [{ catalog_id: 'k1', quantity: 18 }, { catalog_id: 'k3', quantity: null }] }, { phone: '0701234567', type: 'in' }, data);
    if (a.privat || !a.quote) throw new Error('expected quote');
    expect(calc(a.quote.quote).betala).toBe(26512);
  });
  it('unknown catalog ids are ignored', () => {
    const a = analyseFromAi({ ...base, items: [{ catalog_id: 'x', quantity: 5 }] }, { phone: '', type: 'in' }, data);
    expect(!a.privat && a.quote).toBeNull();
  });
  it('add-on on an existing assignment', () => {
    const a = analyseFromAi({ ...base, job_kind: 'kök', is_addon: true }, { phone: '0701234567', type: 'in' }, data);
    expect(!a.privat && a.assignment?.kind === 'befintligt' && a.assignment.assignment.id).toBe('a2');
  });
  it('new customer and assignment persist for the next call', () => {
    const ai = { ...base, customer_name: 'Oskar Lind', address: 'Tallvägen 4', job_kind: 'altan' as const, new_job_title: 'Altan 25 kvm' };
    const first = analyseFromAi(ai, { phone: '0739876543', type: 'in' }, data);
    const reg = applyToRegister(customers, first, null, first.privat ? null : first.assignment, 1);
    expect(reg).toHaveLength(customers.length + 1);
    const second = analyseFromAi({ ...ai, is_addon: true }, { phone: '0739876543', type: 'in' }, { customers: reg, catalog });
    expect(!second.privat && second.customer.kind).toBe('befintlig');
    expect(!second.privat && second.assignment?.kind === 'befintligt' && second.assignment.addOn).toBe(true);
  });
  it('Ring estim matches by name and address, not the employee phone', () => {
    const a = analyseFromAi({ ...base, customer_name: 'Karl Ström', address: 'Lindvägen 2', job_kind: 'målning' }, { phone: '0701112233', type: 'ring' }, data);
    expect(!a.privat && a.customer.kind === 'befintlig' && a.customer.customer.id).toBe('c6');
  });
  it('shared phone still needs confirmation', () => {
    const a = analyseFromAi({ ...base, job_kind: 'målning' }, { phone: '08-555 123 45', type: 'in' }, data);
    expect(!a.privat && a.customer.kind).toBe('oklar');
  });
});
