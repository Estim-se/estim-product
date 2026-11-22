import { extractText, getDocumentProxy } from 'unpdf';
// Called only on bounded physical-page chunks; scans remain document inputs to Claude.
export async function extractTenderPdfPageText(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { maxImageSize: 16_777_216 });
  try {
    const result = await extractText(pdf, { mergePages: false });
    return typeof result.text === 'string' ? [result.text] : result.text;
  } finally { await pdf.loadingTask.destroy(); }
}