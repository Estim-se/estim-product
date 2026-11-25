import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0';

export interface ConversationMessage {
  id: string;
  from: string;
  text: string;
  sent_at: string;
  created_at: string;
}

// Fetch every page; PostgREST's row limit must never silently truncate a thread.
// Failed/pending outbound attempts and system notices are not things the customer heard.
export async function loadConversation(db: SupabaseClient, threadId: string, companyId: string): Promise<ConversationMessage[]> {
  const messages: ConversationMessage[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db.from('messages')
      .select('id,from,text,sent_at,created_at')
      .eq('company_id', companyId).eq('thread_id', threadId)
      .eq('delivery_status', 'sent').in('from', ['kund', 'vv', 'ai'])
      .order('sent_at').order('created_at').order('id')
      .range(offset, offset + pageSize - 1);
    if (error || !data) throw new Error('Kunde inte läsa hela konversationen');
    messages.push(...data);
    if (data.length < pageSize) return messages;
  }
}

export function formatConversation(messages: { from: string; text: string; time?: string }[]): string {
  return messages.map((message, index) =>
    `[${index + 1}. ${message.from === 'kund' ? 'Kund' : message.from === 'ai' ? 'Firman (automatiskt skickat av AI)' : 'Firman (manuellt skickat)'}${message.time ? ' ' + message.time : ''}]\n${message.text}`,
  ).join('\n\n');
}