import { DOCUMENT_URL_SECONDS, documentFilename, documentsEnabled } from './document-policy.ts';
import { deliverWhatsApp, type WhatsAppInput } from './whatsapp.ts';

// Reservations are created atomically with the outgoing message. Never retry an
// uncertain document delivery: the durable reservation prevents duplicates.
export async function deliverDocumentReply(db: any, messageId: string, input: WhatsAppInput) {
  const company = await db.from('messages').select('company_id,thread_id').eq('id', messageId).single();
  if (!company.data || company.error) throw new Error('Message missing');
  const cid = company.data.company_id;
  const [setting, draft, reservations] = await Promise.all([
    db.from('companies').select('settings').eq('id', cid).single(),
    db.from('drafts').select('document_ids').eq('thread_id', company.data.thread_id).eq('company_id', cid).maybeSingle(),
    db.from('company_document_deliveries').select('*').eq('message_id', messageId).eq('company_id', cid).order('created_at').order('id'),
  ]);
  if (setting.error || draft.error || reservations.error) throw new Error('Document lookup failed');
  const rows = reservations.data ?? [];
  const fail = (error: string) => ({ sent: false, error, providerId: null });
  if (!documentsEnabled(setting.data?.settings) && (rows.length || draft.data?.document_ids?.length)) {
    return fail('Dokumentutskick är avstängt. Skapa ett nytt AI-svar innan du skickar.');
  }
  if (!rows.length) {
    if (draft.data?.document_ids?.length) return fail('Dokumentet är borttaget eller redan skickat. Skapa ett nytt AI-svar.');
    return deliverWhatsApp(input);
  }
  // Resolve all originals before sending anything; do not send stale/replaced files.
  const documents = [];
  for (const row of rows) {
    if (row.state !== 'reserved') return fail('Dokumentutskicket har redan behandlats.');
    const original = await db.from('company_documents').select('*').eq('id', row.document_id).eq('company_id', cid).maybeSingle();
    if (original.error || !original.data || original.data.file_path !== row.file_path) return fail('Dokumentet har ändrats eller tagits bort. Skapa ett nytt AI-svar.');
    const signed = await db.storage.from('company-documents').createSignedUrl(row.file_path, DOCUMENT_URL_SECONDS);
    if (signed.error || !signed.data?.signedUrl) return fail('Dokumentlänken kunde inte skapas.');
    documents.push({ row, url: signed.data.signedUrl, filename: documentFilename(original.data) });
  }
  let providerId: string | null = null;
  if (documents.length > 1) {
    const result = await deliverWhatsApp(input);
    if (!result.sent) return result;
    providerId = result.providerId;
  }
  for (const doc of documents) {
    // Persist the attempted state before the request, including ambiguous failures.
    const attempted = await db.from('company_document_deliveries').update({ state: 'attempted' }).eq('id', doc.row.id).eq('state', 'reserved').select('id').single();
    if (attempted.error || !attempted.data) return fail('Dokumentutskicket kunde inte reserveras.');
    const result = await deliverWhatsApp({ ...input, text: documents.length === 1 ? input.text : doc.row.name, documentUrl: doc.url, documentFilename: doc.filename });
    const saved = await db.from('company_document_deliveries').update({ state: result.sent ? 'sent' : 'unknown', provider_message_id: result.providerId }).eq('id', doc.row.id);
    if (saved.error) return fail('Dokumentets leveransstatus kunde inte sparas.');
    if (!result.sent) return result;
    providerId ??= result.providerId;
  }
  return { sent: true, error: null, providerId };
}