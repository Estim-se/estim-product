import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  handler: null as null | ((req: Request) => Promise<Response>),
  calls: [] as { system: string; messages: { content: string }[] }[],
  replies: [] as { text: string; why: string; answered_questions: string[]; document_ids: string[]; material_product_reference: string | null }[],
  saved: null as null | Record<string, unknown>,
  history: [
    { from: 'kund', text: 'Jag behöver spotlights och 23 uttag.', sent_at: '2026-11-20T10:00:00Z' },
    { from: 'ai', text: 'Ca 20 000–24 000 kr. Gäller det byte av alla 23 uttag?', sent_at: '2026-11-20T10:01:00Z' },
    { from: 'kund', text: 'har ni försäkring?', sent_at: '2026-11-20T10:02:00Z' },
  ],
}));
vi.mock('../../supabase/functions/_shared/auth.ts', () => ({ requireCompany: async () => ({ companyId: 'test-company', db: {
  from: (table: string) => {
    const rows: Record<string, unknown> = {
      threads: { id: 'test-thread', customer_id: 'test-customer', interpretation: { customer_questions: [{ question: 'Vad kostar spotlights?' }], follow_up_questions: ['Gäller det byte av alla 23 uttag?'], recommended_action: 'offert' } },
      companies: { name: 'Testfirma', signature: 'Mohamed ali', settings: [] }, customers: { name: 'Erik' },
      quotes: { nr: '1001', owners: 1, add_on: false, prisform: 'uppskattning', lines: [{ id: 'work', t: 'Byte av uttag', typ: 'arbete', q: 1, p: 700, rot: true }] },
      drafts: { channel: 'wa', variant: 'std', attachments: [] }, company_documents: [], company_document_deliveries: [],
    };
    const builder = {
      select: () => builder, eq: () => builder, order: () => builder, limit: () => builder, range: () => builder,
      update: (data: Record<string, unknown>) => { if (table === 'drafts') state.saved = data; return builder; },
      maybeSingle: async () => ({ data: rows[table], error: null }), single: async () => ({ data: rows[table], error: null }),
      then: (resolve: (data: unknown) => unknown) => Promise.resolve({ data: rows[table], error: null }).then(resolve),
    };
    return builder;
  },
} }) }));
vi.mock('../../supabase/functions/_shared/conversation.ts', () => ({
  loadConversation: async () => state.history,
  formatConversation: (messages: { from: string; text: string }[]) => messages.map(message => `${message.from}: ${message.text}`).join('\n'),
}));
vi.mock('../../supabase/functions/_shared/log.ts', () => ({ logAiCall: async () => {} }));
vi.mock('../../supabase/functions/_shared/anthropic.ts', () => ({
  AiError: class extends Error {},
  callClaudeTool: async (input: { system: string; messages: { content: string }[] }) => {
    state.calls.push(structuredClone(input));
    const data = state.replies.shift(); if (!data) throw new Error('Missing test reply');
    return { data, model: 'test', durationMs: 1, inputTokens: 1, outputTokens: 1 };
  },
}));

const response = (text: string) => ({ text, why: 'Test', answered_questions: ['har ni försäkring?'], document_ids: [], material_product_reference: null });
beforeEach(async () => {
  state.calls = []; state.replies = []; state.saved = null;
  vi.stubGlobal('Deno', { serve: (handler: (req: Request) => Promise<Response>) => { state.handler = handler; } });
  vi.resetModules();
  // Keep Deno-only modules out of the application's TypeScript graph while exercising the real handler in Vitest.
  const edgeModule = '../../supabase/functions/write-reply/index.ts';
  await import(/* @vite-ignore */ edgeModule);
});
async function draft() {
  if (!state.handler) throw new Error('No reply handler');
  return state.handler(new Request('https://test.example/write-reply', { method: 'POST', body: JSON.stringify({ thread_id: 'test-thread', channel: 'wa' }) }));
}
describe('WhatsApp draft generation and persisted review rules', () => {
  it('does not force a changed old quote or pending price question into an insurance reply', async () => {
    state.replies = [response('Jag behöver kontrollera våra försäkringsuppgifter först.')];
    const result = await (await draft()).json();
    expect(result.warnings).toEqual([]);
    expect(result.needs_review).toBe(false);
    expect(state.calls).toHaveLength(1);
    const context = state.calls[0]?.messages[0]?.content ?? '';
    expect(context).toContain('PRIS NU: Ge inga belopp');
    expect(context).not.toContain('MÖJLIGA PRISAVGÖRANDE FÖLJDFRÅGOR');
    expect(context).toContain('SENASTE MEDDELANDE FRÅN KUNDEN (enda meddelandet du ska besvara):\nhar ni försäkring?');
    expect(state.saved?.['text']).toBe('Jag behöver kontrollera våra försäkringsuppgifter först.');
  });
  it('retries repeated pending questions and retains review-required status if both attempts fail', async () => {
    state.replies = [response('Gäller det byte av alla 23 uttag?'), response('Ska vi byta alla 23 uttag?')];
    const result = await (await draft()).json();
    expect(state.calls).toHaveLength(2);
    expect(result.needs_review).toBe(true);
    expect(state.saved?.['needs_review']).toBe(true);
  });
  it('retries the reported generic material claim and saves only the corrected reply when retry succeeds', async () => {
    state.replies = [response('I priset ingår arbete, material och framkörning.'), response('Jag behöver kontrollera våra försäkringsuppgifter först.')];
    const result = await (await draft()).json();
    expect(state.calls).toHaveLength(2);
    expect(result.warnings).toEqual([]);
    expect(state.saved?.['text']).toBe('Jag behöver kontrollera våra försäkringsuppgifter först.');
  });
});