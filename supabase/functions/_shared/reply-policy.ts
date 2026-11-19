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