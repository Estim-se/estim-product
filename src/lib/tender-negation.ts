// Removes negated or excluded phrases from short Swedish labels before keyword matching, so that
// "Dubbla vägguttag kök (exkl. diskmaskin)" is not read as a dishwasher outlet and "ej lägenhetsunderlag"
// is not read as apartments. Only the negated clause is removed; the rest of the label is kept.
export const BOUNDARY = '(?<![\\p{L}\\p{N}])';
export const END_WORD = '(?![\\p{L}\\p{N}])';
const NEGATION = `${BOUNDARY}(?:ej|inte|icke|ingen|inga|utan|exkl\\.?|exklusive|förutom|utöver|undantaget|bortsett från)${END_WORD}`;
// Clause ends at a separator, a closing bracket, a dash between words or a sentence-ending full stop.
const CLAUSE_END = '(?=[,;:)\\]|]|\\s[–—-]\\s|\\.(?:\\s|$)|$)';
// A negated list ("ej diskmaskin, kyl eller frys") continues over commas when och/eller closes the list.
const LIST = `(?:[^,;:)\\]|]*,(?=[^;:)\\]|]*?${BOUNDARY}(?:och|eller)${END_WORD}))*`;
const PREFIX = new RegExp(`${NEGATION}(?:\\s+inkl\\.?|\\s+inräknat|\\s+medräknat)?${LIST}[^,;:)\\]|]*?${CLAUSE_END}`, 'giu');
// "lägenheter ingår ej": the clause before the negation, bounded by separators or a spaced dash.
const POSTFIX = new RegExp(`[^,;:()\\[\\]|–—]*?${BOUNDARY}(?:ingår|ingående|medräknas|räknas)\\s+(?:ej|inte)${END_WORD}`, 'giu');

export function withoutNegatedTerms(text: string) {
  return text.replace(POSTFIX, ' ').replace(PREFIX, ' ').replace(/\(\s*\)|\[\s*\]/g, ' ').replace(/\s+/g, ' ').trim();
}
