// Short assignment titles and full customer addresses for call handoffs. Browser-safe and pure.
// The title is only a label: the full work description is kept separately as the Inbox message.
export const ASSIGNMENT_TITLE_MAX = 80;
const JOB_NAMES: Record<string, string> = { uttag: 'Eluttag', laddbox: 'Laddbox', elcentral: 'Elcentral', felsokning: 'Felsökning', badrum: 'Badrum', belysning: 'Belysning', annat: 'Elarbete' };

// Cuts text at a word boundary so the result never exceeds `max` characters.
export function shortTitle(text: string | null | undefined, max = ASSIGNMENT_TITLE_MAX): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1), space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, '')}…`;
}

type TitleSource = { title?: string | null; fields: { job_type?: { value: string } | null; description?: { value: string } | null } };
// AI title first; otherwise the job type and the first clause of the description. Never empty, never over the limit.
export function assignmentTitle(i: TitleSource | null | undefined, fallback?: string | null): string {
  const ai = shortTitle(i?.title);
  if (ai) return ai;
  const kind = i?.fields.job_type ? JOB_NAMES[i.fields.job_type.value] ?? null : null;
  const first = (i?.fields.description?.value ?? fallback ?? '').split(/[.;\n]|,\s/)[0]?.trim() ?? '';
  const joined = kind && first ? `${kind}: ${first}` : kind ?? first;
  return shortTitle(joined) || 'Arbete';
}

// Street address with the town appended when the town is not already part of it.
export function fullAddress(address: string | null | undefined, place: string | null | undefined): string | null {
  const a = (address ?? '').trim(), p = (place ?? '').trim();
  if (!a) return null;
  return p && !a.toLowerCase().includes(p.toLowerCase()) ? `${a}, ${p}` : a;
}
