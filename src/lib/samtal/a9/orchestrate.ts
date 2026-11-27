// A9 dependency-injected orchestration. The real lookup persists its own candidate IDs before consulting AI.
// No fake quote sink, no provider calls or shared inbox writes. Integration remains opt-in and unapplied.
import { decideAssignment, decideCustomer, type Assignment, type AssignmentDecision, type Customer, type CustomerDecision, type Facts, type Segment } from './matching';
export type Lease = { call: string; company: string; job: string; token: string };
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
export type AssignmentAi = (input: { facts: Facts; assignments: Assignment[]; segments: Segment[] }) => Promise<unknown>;
export async function prepareMatching(rpc: Rpc, lease: Lease, f: Facts, segments: Segment[], ai: AssignmentAi) {
  const args = { p_call: lease.call, p_company: lease.company, p_job: lease.job, p_token: lease.token };
  const lookup = await rpc('samtal_a9_candidates', { ...args, p_name: f.name, p_phone: f.phone, p_address: f.address });
  if (lookup.error) throw new Error('matching_read_failed');
  const r = lookup.data as { status: string; customers: Customer[]; customer_truncated: boolean } | null;
  if (r?.status !== 'ok') return { status: 'stopped' };
  const customer = decideCustomer(lease.company, f, r.customers, r.customer_truncated);
  let assignment: AssignmentDecision | null = null;
  if (customer.customer_id) {
    const found = await rpc('samtal_a9_assignments', { ...args, p_customer: customer.customer_id });
    if (found.error) throw new Error('assignments_read_failed');
    const a = found.data as { status: string; assignments: Assignment[]; truncated: boolean } | null;
    if (a?.status !== 'ok') return { status: 'stopped' };
    const live = await rpc('samtal_safety_live', args);
    if (live.error || live.data !== true) return { status: 'stopped' };
    // Do not initialize an AI provider here. The approved worker injects one later.
    const raw = await ai({ facts: f, assignments: a.assignments, segments });
    assignment = decideAssignment(lease.company, customer.customer_id, f, a.assignments, raw, segments, a.truncated);
  }
  const saved = await rpc('samtal_a9_save', { ...args, p_customer: customer, p_assignment: assignment });
  if (saved.error) throw new Error('matching_write_failed');
  return saved.data as { status: string; customer?: CustomerDecision; assignment?: AssignmentDecision };
}
