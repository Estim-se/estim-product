import { describe, expect, it } from 'vitest';
import { SAMTAL_TEST_COMPANY_ID, samtalCompanyAllowed, samtalTestAllowed, transcriptSegments } from '@/lib/samtal/test-mode';

describe('Samtal test mode', () => {
  it('allows only allowlisted users in Bygg Demo AB', () => {
    expect(samtalTestAllowed('moi-ali@hotmail.com', SAMTAL_TEST_COMPANY_ID)).toBe(true);
    expect(samtalTestAllowed('Hassan@FutureVentures.se', SAMTAL_TEST_COMPANY_ID)).toBe(true);
    expect(samtalTestAllowed('someone@else.se', SAMTAL_TEST_COMPANY_ID)).toBe(false);
  });
  it('refuses the other company named Bygg Demo AB', () => {
    expect(samtalTestAllowed('moi-ali@hotmail.com', 'afe18408-f55a-4e76-b7e2-6b33ffb8f182')).toBe(false);
    expect(samtalCompanyAllowed('afe18408-f55a-4e76-b7e2-6b33ffb8f182')).toBe(false);
    expect(samtalCompanyAllowed(SAMTAL_TEST_COMPANY_ID)).toBe(true);
  });
  it('turns pasted lines into ordered segments with speakers', () => {
    expect(transcriptSegments('Kund: Hej\n\nDaniel: Hej, vad gäller det?')).toEqual([
      { start: 0, end: 6, speaker: 'Kund', text: 'Hej' },
      { start: 6, end: 12, speaker: 'Daniel', text: 'Hej, vad gäller det?' },
    ]);
  });
});

describe('Samtal test sending protection', () => {
  it('blocks external sending for Bygg Demo AB threads that hold a Samtal message, any channel', async () => {
    const { samtalTestSendBlocked } = await import('@/lib/samtal/test-mode');
    expect(samtalTestSendBlocked(SAMTAL_TEST_COMPANY_ID, true)).toBe(true);
    expect(samtalTestSendBlocked(SAMTAL_TEST_COMPANY_ID, false)).toBe(false);
    expect(samtalTestSendBlocked('f4795ac8-a755-4595-bb30-56922fee8031', true)).toBe(false);
  });
});
