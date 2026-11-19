import { describe, expect, it } from 'vitest';
import { receiveFailureDetails } from '@/lib/receive-diagnostics';
import { parseIncoming } from '@/lib/channel-rules';

describe('receive diagnostics', () => {
  it('accepts the supplied n8n object without an optional timestamp', () => {
    const input = { channel: 'wa', phone_number_id: '1516723658186972', customer_phone: '46790138124', customer_name: 'Hassan Kasuija', text: '...', provider_message_id: '...' };
    expect(parseIncoming(input)).toEqual(input);
  });
  it('identifies invalid JSON without logging the contents', () => {
    expect(receiveFailureDetails('body', new SyntaxError('private content'))).toEqual({ stage: 'body', kind: 'invalid_json', code: undefined, issues: [] });
  });
  it('reports database codes without provider messages or details', () => {
    expect(receiveFailureDetails('ingestion', { code: '42501', message: 'private content', details: 'private content' })).toEqual({ stage: 'ingestion', kind: 'server_error', code: '42501', issues: [] });
  });
  it('reports invalid fields without customer input', () => {
    try { parseIncoming({ channel: 'wa', phone_number_id: '1516723658186972', customer_phone: '46790138124', text: 'private content' }); }
    catch (error) { expect(receiveFailureDetails('validation', error).issues).toContainEqual({ field: 'provider_message_id', code: 'invalid_type' }); return; }
    throw new Error('Expected validation to fail');
  });
});