import { describe, expect, it } from 'vitest';
import { documentFileError, documentPath } from '@/lib/documents';

describe('company documents', () => {
  it('accepts PDF and images up to 10 MB', () => {
    expect(documentFileError({ type: 'application/pdf', size: 10 * 1024 * 1024 })).toBeNull();
    expect(documentFileError({ type: 'image/png', size: 1000 })).toBeNull();
  });
  it('rejects files over 10 MB', () => {
    expect(documentFileError({ type: 'application/pdf', size: 10 * 1024 * 1024 + 1 })).toBe('Filen är större än 10 MB.');
  });
  it('rejects other file types', () => {
    expect(documentFileError({ type: 'application/zip', size: 10 })).not.toBeNull();
  });
  it('stores files inside the company folder', () => {
    expect(documentPath('c1', 'Försäkring 2026.pdf', 'x').startsWith('c1/x-')).toBe(true);
  });
});
