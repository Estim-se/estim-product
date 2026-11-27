// estim Samtal A3/A4 (Ring estim): the AI that structures a voice note, through the same Lovable AI gateway route as
// the call interpretation (LOVABLE_API_KEY, server-only). One forced tool call; the transcript is data only.
import { SamtalAiError } from '../ai.server';
import { transcriptForAi, type Transcript } from '../transcript';
import { RING_VOICE_NOTE_PROMPT, voiceNoteToolSchema } from './voice-note';

export interface RingAi { readonly id: string; interpretVoiceNote(transcript: Transcript, context: { today: string }): Promise<unknown> }

export function gatewayRingAi(options: { key?: string | undefined; model?: string | undefined; fetch?: typeof fetch } = {}): RingAi {
  const request = options.fetch ?? fetch;
  const configured = options.model ?? process.env['SAMTAL_AI_MODEL'] ?? process.env['ANTHROPIC_MODEL_MAIN'] ?? 'claude-sonnet-5';
  const model = configured.startsWith('anthropic/') ? configured : `anthropic/${configured}`;
  return {
    id: 'lovable-gateway',
    async interpretVoiceNote(transcript, context) {
      const key = options.key ?? process.env['LOVABLE_API_KEY'];
      if (!key) throw new SamtalAiError('ai_not_configured', true);
      let response: Response;
      try {
        response = await request('https://ai.gateway.lovable.dev/v1/messages', {
          method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Lovable-AIG-SDK': 'fetch' }, signal: AbortSignal.timeout(120_000),
          body: JSON.stringify({
            model, max_tokens: 6000, system: RING_VOICE_NOTE_PROMPT,
            tools: [{ name: 'rostanteckning', description: 'Strukturerad röstanteckning med källa per uppgift.', input_schema: voiceNoteToolSchema }],
            tool_choice: { type: 'tool', name: 'rostanteckning' },
            messages: [{ role: 'user', content: `Dagens datum: ${context.today}.\n<utskrift>\n${transcriptForAi(transcript)}\n</utskrift>` }],
          }),
        });
      } catch { throw new SamtalAiError('ai_unreachable', true); }
      if (!response.ok) throw new SamtalAiError(`ai_http_${response.status}`, response.status === 429 || response.status >= 500);
      const body = await response.json().catch(() => null) as { content?: { type: string; name?: string; input?: unknown }[] } | null;
      const tool = body?.content?.find(c => c.type === 'tool_use' && c.name === 'rostanteckning');
      if (!tool) throw new SamtalAiError('ai_invalid_output', true);
      return tool.input;
    },
  };
}
