import { describe, expect, it } from 'vitest';
import { inviteTemplateData } from '@/lib/invite-metadata';

describe('inviteTemplateData', () => {
  it('keeps trimmed, non-empty names only', () => {
    expect(inviteTemplateData('  Anna  ', ' Kalles El AB ')).toEqual({ inviter_name: 'Anna', company_name: 'Kalles El AB' });
    expect(inviteTemplateData('   ', null)).toEqual({});
    expect(inviteTemplateData(undefined, '')).toEqual({});
  });
  it('caps each name at 80 characters without splitting an emoji', () => {
    const long = `${'a'.repeat(79)}😀😀`;
    const out = inviteTemplateData(long, null).inviter_name ?? '';
    expect(Array.from(out)).toHaveLength(80);
    expect(out.endsWith('😀')).toBe(true);
  });
  it('removes < and > so a name cannot add markup to the mail, and keeps &', () => {
    expect(inviteTemplateData('<a href="https://x.se">Klicka</a>', 'Bygg & El AB')).toEqual({ inviter_name: 'a href="https://x.se"Klicka/a', company_name: 'Bygg & El AB' });
    expect(inviteTemplateData('<>', '  <b>  ')).toEqual({ company_name: 'b' });
  });
  it('never sets keys the profile trigger reads', () => {
    expect(Object.keys(inviteTemplateData('Anna', 'Firma'))).not.toContain('display_name');
  });
});
