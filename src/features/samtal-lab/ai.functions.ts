// Samtal Test Lab: the only server function of the lab. It sends the pasted, synthetic transcript to the
// Lovable AI Gateway for fact extraction. No database, storage or other service is touched; the key stays server-side.
import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { LAB_AI_LIMITS, isAllowedDemoUser, newBudget, reserveCall } from './ai-policy';
import type { AiExtraction, CallType } from './analyze';
import { labAiPrompt } from './ai-prompt';

const budget = newBudget();

type Input = { text: string; type: CallType; employee: string; customerHints: string[] };
export type LabAiResult = { ok: true; data: AiExtraction } | { ok: false; error: string };

function validate(raw: unknown): Input {
  const r = raw as Partial<Input> | null;
  if (!r || typeof r.text !== 'string' || !r.text.trim()) throw new Error('Transkribering saknas.');
  if (r.text.length > LAB_AI_LIMITS.maxChars) throw new Error(`Transkriberingen får vara högst ${LAB_AI_LIMITS.maxChars} tecken.`);
  if (r.type !== 'in' && r.type !== 'ut' && r.type !== 'ring') throw new Error('Ogiltig typ.');
  const hints = Array.isArray(r.customerHints) ? r.customerHints.filter((h): h is string => typeof h === 'string').slice(0, 50).map(h => h.slice(0, 120)) : [];
  return { text: r.text, type: r.type, employee: typeof r.employee === 'string' ? r.employee.slice(0, 80) : '', customerHints: hints };
}

export const labAnalyseWithAi = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator(validate)
  .handler(async ({ data, context }): Promise<LabAiResult> => {
    const claims = context.claims as { email?: unknown };
    if (!isAllowedDemoUser(claims.email)) return { ok: false, error: 'Riktig AI är inte aktiverad för ditt konto.' };
    const denied = reserveCall(budget, context.userId, Date.now());
    if (denied) return { ok: false, error: denied };
    const apiKey = process.env['LOVABLE_API_KEY'];
    if (!apiKey) return { ok: false, error: 'AI-nyckel saknas på servern.' };

    const [{ createOpenAI }, { streamText, Output, jsonSchema, NoObjectGeneratedError, APICallError }, { catalog }] = await Promise.all([
      import('@ai-sdk/openai'), import('ai'), import('./data'),
    ]);
    const provider = createOpenAI({ baseURL: 'https://ai.gateway.lovable.dev/v1', apiKey, headers: { 'Lovable-API-Key': apiKey, 'X-Lovable-AIG-SDK': 'vercel-ai-sdk' } });
    const { system, schemaJson } = labAiPrompt(data, catalog);
    const schema = jsonSchema<AiExtraction>(schemaJson);
    try {
      const result = streamText({
        model: provider.responses('openai/gpt-6-astra'),
        instructions: system,
        messages: [{ role: 'user', content: data.text }],
        output: Output.object({ schema }),
        maxRetries: 0,
        providerOptions: { openai: { store: false, forceReasoning: true, reasoningEffort: 'low', reasoningSummary: 'auto', include: ['reasoning.encrypted_content'] } },
      });
      return { ok: true, data: await result.output };
    } catch (e) {
      if (NoObjectGeneratedError.isInstance(e)) return { ok: false, error: 'AI:n gav inget tolkbart svar. Försök igen eller använd regelbaserad analys.' };
      if (APICallError.isInstance(e)) {
        const s = e.statusCode;
        console.error('[samtal-lab] gateway status', s);
        if (s === 402) return { ok: false, error: 'AI-krediterna räcker inte. Fyll på under Settings → Plans & credits.' };
        if (s === 429) return { ok: false, error: 'AI:n är tillfälligt överbelastad. Vänta en stund och försök igen.' };
        if (s === 403) return { ok: false, error: 'AI-anropet nekades för arbetsytan.' };
        return { ok: false, error: `AI-anropet misslyckades (${s ?? 'okänt'}).` };
      }
      console.error('[samtal-lab] ai error', e instanceof Error ? e.name : 'unknown');
      return { ok: false, error: 'AI-anropet misslyckades.' };
    }
  });
