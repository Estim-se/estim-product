// Browser-safe helpers for linking customer records. Phone normalization must stay identical to the
// database function estim_norm_phone so suggestions and server-side matching agree.

/** Digits only; "+46"/"0046" and a leading national "0" all become the "46…" form. */
export function normalizePhone(value: string | null | undefined): string {
  let digits = (value ?? '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = `46${digits.slice(1)}`;
  return digits.length >= 8 ? digits : '';
}

export function normalizeEmail(value: string | null | undefined): string {
  const email = (value ?? '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : '';
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Swedish mobile numbers only (07x / +467x): landlines and org numbers are too ambiguous to link on.
const MOBILE_RE = /(?:\+46|0046|\b0)[\s-]*7[02369](?:[\s-]*\d){7}\b/g;

/** Contact details written in a message text, normalized. */
export function mentionedContacts(text: string): { phones: string[]; emails: string[] } {
  const phones = [...new Set((text.match(MOBILE_RE) ?? []).map(normalizePhone).filter(Boolean))];
  const emails = [...new Set((text.match(EMAIL_RE) ?? []).map(normalizeEmail).filter(Boolean))];
  return { phones, emails };
}

export interface LinkCustomer { id: string; name: string; phone: string | null; email: string | null }
export interface LinkInput {
  customerId: string;
  customers: LinkCustomer[];
  threads: { id: string; customer_id: string }[];
  messages: { thread_id: string; from: string; text: string }[];
  /** The company's own addresses/numbers (reply-to, inbound address, signature) never link customers. */
  own: { phones: string[]; emails: string[] };
}
export interface MergeCandidate { id: string; name: string; reason: string }

/**
 * Other customers that are probably the same person: identical contact details after normalization,
 * or one customer's own messages mention the other's phone/email. Suggestions only; merging is manual
 * because a mentioned number can belong to someone else (a partner, the housing association).
 */
export function mergeCandidates(input: LinkInput): MergeCandidate[] {
  const me = input.customers.find(c => c.id === input.customerId);
  if (!me) return [];
  const ownPhones = new Set(input.own.phones.map(normalizePhone).filter(Boolean));
  const ownEmails = new Set(input.own.emails.map(normalizeEmail).filter(Boolean));
  const threadOwner = new Map(input.threads.map(t => [t.id, t.customer_id]));
  const mentions = new Map<string, { phones: Set<string>; emails: Set<string> }>();
  for (const m of input.messages) {
    if (m.from !== 'kund') continue;
    const owner = threadOwner.get(m.thread_id);
    if (!owner) continue;
    const found = mentionedContacts(m.text), entry = mentions.get(owner) ?? { phones: new Set(), emails: new Set() };
    found.phones.forEach(p => { if (!ownPhones.has(p)) entry.phones.add(p); });
    found.emails.forEach(e => { if (!ownEmails.has(e)) entry.emails.add(e); });
    mentions.set(owner, entry);
  }
  const contact = (c: LinkCustomer) => ({ phone: normalizePhone(c.phone), email: normalizeEmail(c.email) });
  const mine = contact(me), myMentions = mentions.get(me.id);
  const result: MergeCandidate[] = [];
  for (const other of input.customers) {
    if (other.id === me.id) continue;
    const theirs = contact(other), theirMentions = mentions.get(other.id);
    // Replies go to the customer's stored phone/e-mail, so two different numbers or addresses must never
    // be merged: one conversation's replies would reach the other person.
    if ((mine.phone && theirs.phone && mine.phone !== theirs.phone) || (mine.email && theirs.email && mine.email !== theirs.email)) continue;
    let reason = '';
    if ((mine.phone && mine.phone === theirs.phone) || (mine.email && mine.email === theirs.email)) reason = 'Samma kontaktuppgift';
    else if ((theirs.phone && myMentions?.phones.has(theirs.phone)) || (theirs.email && myMentions?.emails.has(theirs.email))) reason = `Kontaktuppgiften nämns av ${me.name || 'kunden'}`;
    else if ((mine.phone && theirMentions?.phones.has(mine.phone)) || (mine.email && theirMentions?.emails.has(mine.email))) reason = `Kontaktuppgiften nämns av ${other.name || 'kunden'}`;
    if (reason) result.push({ id: other.id, name: other.name || 'Okänd kund', reason });
  }
  return result;
}
