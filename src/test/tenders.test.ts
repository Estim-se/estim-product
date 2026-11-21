import { describe, it, expect } from 'vitest';
import { File } from 'node:buffer';
import { zipSync, strToU8 } from 'fflate';
import { prepareTenderFiles, tenderFileType, tenderPath, TENDER_MAX_BYTES, validateTenderTotal } from '@/lib/tenders';

describe('Tender upload rules', () => {
  it('accepts PDF, DOCX and XLSX and rejects other documents', () => {
    expect(['plan.PDF', 'spec.docx', 'prices.xlsx'].map(tenderFileType)).toEqual(['pdf', 'docx', 'xlsx']);
    expect(tenderFileType('photo.png')).toBeNull();
    expect(tenderFileType('archive.zip')).toBeNull();
  });
  it('allows exactly 50 MB total and rejects one additional byte', () => {
    expect(TENDER_MAX_BYTES).toBe(50 * 1024 * 1024);
    expect(() => validateTenderTotal([25 * 1024 * 1024, 25 * 1024 * 1024])).not.toThrow();
    expect(() => validateTenderTotal([TENDER_MAX_BYTES, 1])).toThrow();
  });
  it('unpacks ZIP files into separately named documents alongside direct files', async () => {
    const archive = zipSync({ 'folder/spec.docx': strToU8('docx-data'), 'cost.xlsx': strToU8('xlsx-data') });
    const files = await prepareTenderFiles([new File([new Uint8Array(archive)], 'anbud.zip'), new File(['pdf-data'], 'plan.pdf')]);
    expect(files.map(f => f.name)).toEqual(['spec.docx', 'cost.xlsx', 'plan.pdf']);
    expect(files.map(f => f.size)).toEqual([9, 9, 8]);
    expect(files.map(f => f.type)).toEqual(['docx', 'xlsx', 'pdf']);
  });
  it('rejects ZIP expansion above 50 MB even when compressed input is small', async () => {
    const archive = zipSync({ 'large.pdf': new Uint8Array(TENDER_MAX_BYTES + 1) });
    await expect(prepareTenderFiles([new File([new Uint8Array(archive)], 'large.zip')])).rejects.toThrow('50 MB');
  }, 20000);
  it('rejects unsupported files inside ZIP without partially accepting the archive', async () => {
    const archive = zipSync({ 'ok.pdf': strToU8('PDF'), 'bad.exe': strToU8('exe') });
    await expect(prepareTenderFiles([new File([new Uint8Array(archive)], 'bad.zip')])).rejects.toThrow('Filtypen');
  });
  it('rejects ZIP path traversal', async () => {
    const archive = zipSync({ '../outside.pdf': strToU8('PDF') });
    await expect(prepareTenderFiles([new File([new Uint8Array(archive)], 'bad.zip')])).rejects.toThrow('filsökväg');
  });
  it('keeps company and tender as separate private path segments', () => {
    expect(tenderPath('company-1', 'tender-2', 'file-3', 'Plan.pdf')).toBe('company-1/tender-2/file-3-Plan.pdf');
  });
});