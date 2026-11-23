import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractTenderInsightStep } from '@/lib/tender-insights-ai.server';
import { NOT_SPECIFIED, TENDER_KEY_FIELDS, type TenderInsights } from '@/lib/tender-insights';
import { TENDER_RISK_GROUPS } from '@/lib/tender-risk-checklist';
import { TenderRejectedOutput } from '@/lib/tender-tool-call.server';

// Stored example responses replace the live gateway; no keys or network are needed.
const samples = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/tender-risk-call-responses.json'), 'utf8')) as Record<string, unknown>;
const areas = TENDER_RISK_GROUPS[2];
if (!areas) throw Error('Missing third risk group');
const WARNING = 'Källa saknas – kontrollera';
const id = '00000000-0000-4000-8000-000000000001';
const af = { id, file_name: 'AF.docx', file_type: 'docx', page_count: null, doc_type: 'AF', bytes: new Uint8Array(),
  text: 'AFA.1 Beställare\nBostadsbolaget.\nAFC.54 Försäkringar\nEntreprenören ska ha ansvarsförsäkring.\nAFC.61 Ersättning\nFast pris utan indexreglering.\nAFC.65 Ersättning för ändringar\nPåslag 5 %.\nAFD.1 Allmänt\nTidplan bifogas.' };
const key_data: TenderInsights['key_data'] = TENDER_KEY_FIELDS.map(field => field === 'Ersättningsform'
  ? { field, value: 'Fast pris', source: { document_id: id, page: null, af_code: 'AFC.61', evidence: 'Fast pris utan indexreglering.' } }
  : { field, value: NOT_SPECIFIED, source: null });

const wire = (json: string, stop = 'tool_use', tool = 'risker') => [
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: tool } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json } },
  { type: 'message_delta', delta: { stop_reason: stop } },
  { type: 'message_stop' },
].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
const sample = (name: string) => {
  const value = samples[name];
  if (value === undefined) throw Error(`Missing sample ${name}`);
  return typeof value === 'string' ? value : JSON.stringify(value);
};
function gateway(json: string, stop = 'tool_use') {
  const fetch = vi.fn(async () => new Response(wire(json, stop)));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const run = async () => {
  const result = await extractTenderInsightStep('risks', [af], 'test-key', 'test-model', { key_data }, areas);
  return result.map(risk => {
    if (!('title' in risk)) throw Error('Expected a risk result');
    return risk;
  });
};
async function rejection() {
  vi.useFakeTimers();
  const pending = run().then(() => null, (e: unknown) => e);
  await vi.runAllTimersAsync();
  return pending;
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('risk call output handling', () => {
  it('accepts an empty risk list when every area of the call has a status', async () => {
    const fetch = gateway(sample('emptyWithStatuses'));
    expect(await run()).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never requires a source for "Ej nämnt"', async () => {
    gateway(sample('ejNamntWithoutSource'));
    expect(await run()).toEqual([]);
  });

  it('flags "Normalt" without a verifiable source instead of rejecting the call', async () => {
    const fetch = gateway(sample('normalWithoutSource'));
    const risks = await run();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(risks.find(r => r.title === 'Fast pris utan indexreglering')?.source).toMatchObject({ af_code: 'AFC.61', document_id: id });
    for (const area of ['ÄTA-ersättning och påslag', 'Projekteringsansvar']) {
      const flagged = risks.find(r => r.title === area);
      expect(flagged?.source.flag).toBe(WARNING);
      expect(flagged?.description).toContain('Normalt utan verifierbar AF-källa');
    }
    expect(risks.some(r => r.title === 'Försäkringskrav' || r.title === 'Saknade handlingar')).toBe(false);
  });

  it('keeps usable risks and flags areas missing from a partial checklist', async () => {
    gateway(sample('riskWithPartialChecklist'));
    const risks = await run();
    expect(risks.find(r => r.title === 'Lågt ÄTA-påslag')?.severity).toBe('Hög');
    expect(risks.filter(r => r.source.flag === WARNING && r.description.includes('saknar en entydig bedömning'))).toHaveLength(areas.length - 1);
  });

  it('tolerates area wording drift and oversized or invalid display fields', async () => {
    gateway(sample('wordingDriftAndOversizedText').replace('OVERSIZED', 'x'.repeat(5000)));
    const risks = await run();
    expect(risks).toHaveLength(1);
    expect(risks[0]?.description).toHaveLength(2000);
    expect(risks[0]?.severity).toBe('Låg');
  });

  it.each([
    ['brokenJson', 'tool_use', 'ogiltig JSON'],
    ['truncated', 'max_tokens', 'maxgränsen'],
  ])('rejects %s after three attempts and keeps every raw answer', async (name, stop, reason) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = gateway(sample(name), stop);
    const error = await rejection();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(TenderRejectedOutput);
    const attempts = (error as TenderRejectedOutput).attempts;
    expect(attempts.map(a => a.attempt)).toEqual([1, 2, 3]);
    expect(attempts.every(a => a.raw === sample(name) && a.reason.includes(reason) && a.stop_reason === stop)).toBe(true);
    expect((error as Error).message).toContain(reason);
  });

  it.each([
    ['missingChecklist', 'saknar riskchecklistan'],
    ['emptyWithIncompleteChecklist', 'saknar status för 3 av 5 områden'],
  ])('rejects %s and keeps the raw answer', async (name, reason) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = gateway(sample(name));
    const error = await rejection();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect((error as Error).message).toContain(reason);
    expect((error as TenderRejectedOutput).attempts[0]?.raw).toBe(sample(name));
  });

  it('logs only metadata for rejected attempts, never the raw text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    gateway(sample('brokenJson'));
    await rejection();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Kostnadsökningar');
  });
});

describe('risk call instructions', () => {
  it('asks risk calls only for the flat format and keeps source objects for other steps', async () => {
    const fetch = gateway(sample('emptyWithStatuses'));
    await run();
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [unknown, RequestInit])[1].body));
    expect(body.system).not.toContain('evidence-citat från källsidan');
    expect(body.system).toContain('platt format');
    const input = body.messages[0].content.map((c: { text?: string }) => c.text ?? '').join('\n');
    expect(input).not.toMatch(/"evidence"|"document_id"/);
    expect(input).toContain('"af_code":"AFC.61"');
    expect(input).toContain('Ej nämnt betyder att området inte behandlas och behöver ingen AF-kod');

    const keyFetch = vi.fn(async () => new Response(wire(JSON.stringify({ key_data }), 'tool_use', 'nyckeldata')));
    vi.stubGlobal('fetch', keyFetch);
    await extractTenderInsightStep('key_data', [af], 'test-key', 'test-model');
    expect(JSON.parse(String((keyFetch.mock.calls[0] as unknown as [unknown, RequestInit])[1].body)).system).toContain('evidence-citat från källsidan');
  });
});
