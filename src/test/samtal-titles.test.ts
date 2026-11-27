import { describe, expect, it } from 'vitest';
import { assignmentTitle, fullAddress, shortTitle } from '@/lib/samtal/a10/titles';
import { parseHandoff } from '@/lib/samtal/a10/contracts';

const long = 'Byte av sex ojordade vägguttag till jordade (vardagsrum och sovrum), installation av åtta infällda dimbara LED-spotlights i köket (2700K), två dimmers, tre nya dubbla vägguttag ovanför köksbänk samt uttag till diskmaskin, kontroll av elcentral/grupper och jordfelsbrytare.';

describe('samtal assignment titles', () => {
  it('uses the AI title when given', () => {
    expect(assignmentTitle({ title: 'Elinstallation i villa', fields: { description: { value: long } } })).toBe('Elinstallation i villa');
  });
  it('never exceeds 80 characters, even from a 270-character description', () => {
    const t = assignmentTitle({ fields: { job_type: { value: 'uttag' }, description: { value: long } } });
    expect(t.length).toBeLessThanOrEqual(80);
    expect(shortTitle(long).length).toBeLessThanOrEqual(80);
  });
  it('appends the town to the street address once', () => {
    expect(fullAddress('Björkgatan 18', 'Borås')).toBe('Björkgatan 18, Borås');
    expect(fullAddress('Björkgatan 18, Borås', 'Borås')).toBe('Björkgatan 18, Borås');
  });
  it('shortens an over-long reviewed title instead of rejecting it', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const r = parseHandoff({ call: id, version: 1, request: id, customer: null, assignment: null, create: true, identity: { name: 'A', address: 'B', phone: null }, title: long });
    expect(r.title.length).toBeLessThanOrEqual(80);
  });
  it('gives a plain message instead of raw validation output', () => {
    expect(() => parseHandoff({ call: 'x' })).toThrow(/^[^{\[]*$/);
  });
});

import { decideCustomer } from '@/lib/samtal/a9/matching';
describe('samtal customer recognition without phone', () => {
  const co = '00000000-0000-4000-8000-0000000000aa';
  const cust = { id: '00000000-0000-4000-8000-0000000000bb', company_id: co, name: 'Anna Berg', phone: null, address: 'Lindvägen 5, Ort' };
  it('matches a unique name and street address even when the town was stored with it', () => {
    const d = decideCustomer(co, { kind: 'telefonsamtal', name: 'Anna Berg', phone: null, callerPhone: null, address: 'Lindvägen 5', text: '', quoteRequested: false }, [cust]);
    expect(d.state).toBe('matched');
  });
  it('still asks when the street differs', () => {
    const d = decideCustomer(co, { kind: 'telefonsamtal', name: 'Anna Berg', phone: null, callerPhone: null, address: 'Lindvägen 7', text: '', quoteRequested: false }, [cust]);
    expect(d.state).toBe('ambiguous');
  });
});
