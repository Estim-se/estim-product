// WhatsApp-only content guards; calculation and channel delivery remain separate.
export type ReplyMessage = { from: string; text: string };

export function whatsappReplyFocus(messages: ReplyMessage[]) {
  const latest = messages.filter(message => message.from === 'kund').at(-1)?.text.trim() ?? '';
  const pending = messages.filter(message => message.from !== 'kund')
    .flatMap(message => message.text.match(/[^.!?\n]*\?/g) ?? []).map(question => question.trim());
  return { latest, previousQuestions: [...new Set(pending)] };
}

export function whatsappPriceRelevant(latest: string): boolean {
  if (/(?:pris|kost(?:ar|nad)|hur mycket|vad blir|ROT|avdrag|offert|installera|byta|montera|lägga till|extra uttag)/i.test(latest)) return true;
  // An unrelated information question must not revive an old estimate, even if its totals changed.
  return !(/\?/.test(latest) || /^(?:har ni|är ni|kan jag|vilken|vilket|vilka|vem|var|när|hur|finns|skicka|visa)\b/i.test(latest));
}

function questionWords(text: string): Set<string> {
  return new Set((text.toLocaleLowerCase('sv').match(/[\p{L}\d]+/gu) ?? [])
    .map(word => word === 'byta' ? 'byte' : word)
    .filter(word => (word.length > 2 || /^\d+$/.test(word)) && !['kan', 'det', 'den', 'ska', 'som', 'och', 'att', 'har', 'hur', 'vilka', 'vilken', 'vill', 'alla', 'ett', 'med', 'för'].includes(word)));
}

export function whatsappContentProblems(text: string, messages: ReplyMessage[], materialProductReference: unknown): string[] {
  const problems: string[] = [];
  const { previousQuestions } = whatsappReplyFocus(messages);
  for (const question of text.match(/[^.!?\n]*\?/g) ?? []) {
    const words = questionWords(question);
    if (previousQuestions.some(previous => {
      const oldWords = questionWords(previous);
      const common = [...words].filter(word => oldWords.has(word)).length;
      return words.size > 0 && (question.trim().toLowerCase() === previous.trim().toLowerCase() || common >= 2 && common / Math.min(words.size, oldWords.size) >= 0.75);
    })) problems.push('Samtalsregel: upprepa inte en fråga som firman redan ställt; låt den ligga');
  }
  const reference = typeof materialProductReference === 'string' ? materialProductReference.trim() : '';
  const exactProduct = reference.length >= 5 && /https?:\/\/\S+|(?=.*\p{L})(?=.*\d).{5,}/u.test(reference) &&
    messages.some(message => message.from === 'kund' && message.text.includes(reference));
  const claimsIncluded = /(?:\bmaterial(?:et)?\b[^.!?\n]{0,100}(?:ingår|inkluder|inkl\.|omfattas)|(?:ingår|inkluder|inkl\.|omfattar)[^.!?\n]{0,100}\bmaterial(?:et)?\b)/i.test(text);
  if (claimsIncluded && !exactProduct) problems.push('Materialregel: säg inte att material ingår utan exakt produkt angiven av kunden; priset bygger på standardmaterial från firmans prislista och dyrare produkter tillkommer');
  return problems;
}