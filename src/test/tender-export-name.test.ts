import { describe, expect, it } from 'vitest';
import { tenderExportName } from '@/lib/tender-export';

// The file name replaces Windows-forbidden characters and C0 control characters (U+0000–U+001F) only.
describe('tender export file name', () => {
  it('replaces every forbidden and C0 control character', () => {
    const c0 = Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)).join('');
    expect(tenderExportName(`A${c0}<>:"/\\|?*B`, 'pdf')).toBe(`A${'_'.repeat(41)}B – anbudsbas.pdf`);
  });
  it('keeps DEL, C1 controls, non-ASCII letters and astral characters', () => {
    const kept = 'Å\u007f\u0080\u009fö\u{1F600}';
    expect(tenderExportName(kept, 'xlsx')).toBe(`${kept} – anbudsbas.xlsx`);
  });
});
