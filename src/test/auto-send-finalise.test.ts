import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const delivery = vi.hoisted(() => ({ deliverDocumentReply: vi.fn() }));
vi.mock('../../supabase/functions/_shared/document-delivery', () => delivery);
import { autoSend } from '../../supabase/functions/_shared/auto-send';

// A reserved automatic reply: one message, its thread and customer. Only estim_finish_send can be made to fail.
function fakeDb(finishFails: boolean) {
  const rpc = vi.fn(async (name: string, _args: Record<string, unknown>) =>
    name === 'estim_prepare_auto_send' ? { data: 'message-1', error: null } : { data: null, error: finishFails ? { message: 'down' } : null });
  const rows: Record<string, unknown> = {
    messages: { text: 'Hej', thread_id: 'thread-1', company_id: 'company-1' },
    threads: { customer_id: 'customer-1', last_customer_wa_at: new Date().toISOString() },
    customers: { phone: '46700000000' },
  };
  const from = (table: string) => {
    const query = { select: () => query, eq: () => query, single: async () => ({ data: rows[table] ?? null, error: null }) };
    return query;
  };
  return { db: { rpc, from } as unknown as SupabaseClient, rpc };
}

describe('automatic send finalisation', () => {
  beforeEach(() => { vi.stubGlobal('Deno', { env: { get: () => undefined } }); });
  afterEach(() => { vi.unstubAllGlobals(); delivery.deliverDocumentReply.mockReset(); });

  it('keeps the delivery error as the cause when finalisation also fails', async () => {
    const deliveryError = new Error('WhatsApp gateway timeout');
    delivery.deliverDocumentReply.mockRejectedValue(deliveryError);
    const { db } = fakeDb(true);
    const thrown = await autoSend(db, 'job-1').then(() => null, (error: unknown) => error);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Automatic send finalisation failed');
    expect((thrown as Error).cause).toBe(deliveryError);
  });

  it('records a failed delivery and rethrows the delivery error when finalisation succeeds', async () => {
    const deliveryError = new Error('WhatsApp gateway timeout');
    delivery.deliverDocumentReply.mockRejectedValue(deliveryError);
    const { db, rpc } = fakeDb(false);
    await expect(autoSend(db, 'job-1')).rejects.toBe(deliveryError);
    expect(rpc).toHaveBeenLastCalledWith('estim_finish_send', { mid: 'message-1', delivered: false, failure: 'WhatsApp-svaret kunde inte skickas. Försök igen.', provider_id: null });
  });

  it('finalises a successful delivery once and resolves', async () => {
    delivery.deliverDocumentReply.mockResolvedValue({ sent: true, error: null, providerId: 'wamid-1' });
    const { db, rpc } = fakeDb(false);
    await expect(autoSend(db, 'job-1')).resolves.toBeUndefined();
    expect(rpc.mock.calls.filter(([name]) => name === 'estim_finish_send')).toEqual([['estim_finish_send', { mid: 'message-1', delivered: true, failure: null, provider_id: 'wamid-1' }]]);
  });

  it('reports a finalisation failure after a successful delivery', async () => {
    delivery.deliverDocumentReply.mockResolvedValue({ sent: true, error: null, providerId: 'wamid-1' });
    const { db } = fakeDb(true);
    await expect(autoSend(db, 'job-1')).rejects.toThrow('Automatic send finalisation failed');
  });
});
