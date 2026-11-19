import { calc, type Quote } from './calc.ts';

// Refresh job details for every incoming message, not just a new thread.
export function incomingAiSteps(): string[] {
  return ['interpret-request', 'write-reply'];
}

// A rough range expresses uncertainty; travel is fixed and ROT is recalculated at each end.
export function estimateRange(quote: Quote) {
  const endpoint = (factor: number) => calc({ ...quote, lines: quote.lines.map(line =>
    line.typ === 'resa' || line.typ === 'ovrigt' ? line : { ...line, q: line.q * factor }) });
  return { low: endpoint(0.9), high: endpoint(1.1) };
}

export function firstCompanyReply(messages: { from: string }[]): boolean {
  return !messages.some(message => message.from !== 'kund');
}

// Only require a first/changed estimate or an explicit customer price question.
export function priceNeeded(messages: { from: string; text: string }[], quote?: Quote | null): boolean {
  const latest = messages.filter(message => message.from === 'kund').at(-1)?.text.trim() ?? '';
  if (/(?:pris|kost(?:ar|nad)|hur mycket|vad blir|ROT|avdrag|att betala|price|cost)/i.test(latest)) return true;
  const previous = messages.filter(message => ['vv', 'ai'].includes(message.from)).reverse()
    .find(message => /\d\s*(?:kr\b|kronor|:-)/i.test(message.text));
  if (previous) {
    if (!quote) return false;
    const amounts = [...previous.text.matchAll(/(\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)\s*(?:kr\b|kronor|:-|(?=[–—-]\s*\d))/gi)]
      .map(match => Number(match[1]?.replace(/[ \u00a0\u202f]/g, '')));
    const current = calc(quote);
    const { low, high } = estimateRange(quote);
    const has = (value: number) => amounts.some(amount => Math.abs(amount - value) <= 1);
    // Compare the quoted total/range, not incidental line prices or ROT caps.
    return quote.prisform === 'fast' ? !has(current.inkl) :
      !(has(low.inkl) && has(high.inkl) || has(current.inkl)) ||
      (/ROT|avdrag/i.test(previous.text) && current.av > 0 && !(has(low.betala) && has(high.betala) || has(current.betala)));
  }
  return !/^(?:tack(?: så mycket)?|toppen|perfekt|okej|ok|ja|nej|bra|det låter bra|det blir bra)[\s!.]*$/i.test(latest);
}

export function visitNeeded(interpretation: { recommended_action?: string; risks?: { type: string }[] } | null): boolean {
  return interpretation?.recommended_action === 'platsbesok' ||
    Boolean(interpretation?.risks?.some(risk => ['barande', 'fukt_vatrum', 'asbest', 'bygglov'].includes(risk.type)));
}

// Remove boilerplate on later WhatsApp turns even if the model ignored the format instruction.
export function continueReply(text: string, signature: string, first: boolean): string {
  if (first) return text;
  let body = text.trim().replace(/^(?:hej|hejsan|hallå|tjena)(?:\s+[^\n!?.,]{1,60})?[!?.,]\s*/i, '');
  const sig = signature.trim();
  if (sig && body.endsWith(sig)) body = body.slice(0, -sig.length).trim().replace(/(?:\/|(?:med vänliga hälsningar|vänliga hälsningar|hälsningar|mvh)[,!]?)\s*$/i, '').trim();
  return body;
}