// estim Samtal A3/A4/A5 (Ring estim): Swedish relative deadlines resolved in code from the words of the note and the
// call time in Swedish time. The AI only quotes the phrase; it never supplies a date. Browser-safe and pure.
const WEEKDAYS = ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'] as const;
const MONTHS = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'] as const;
const NUMBERS: Record<string, number> = { en: 1, ett: 1, två: 2, tre: 3, fyra: 4, fem: 5, sex: 6, sju: 7, åtta: 8, nio: 9, tio: 10, fjorton: 14 };

// A5: a deadline is a calendar date. due_at (an instant) exists only when a time was actually spoken ("klockan 14");
// "senast på fredag" stays date-only. A configured default time is applied separately (withDefaultTime) and marked
// time_source 'standard' so it can never be mistaken for a customer-stated time.
export type Deadline = { date: string; time: string | null; due_at: string | null; time_source: 'angiven' | null; uncertain: string | null };
export type TimedDeadline = Omit<Deadline, 'time_source'> & { time_source: 'angiven' | 'standard' | null };

// The calendar date of an instant in Europe/Stockholm, as YYYY-MM-DD.
export function stockholmDate(instant: string | Date) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
}
// A Swedish wall-clock time on a date, as an instant (handles summer and winter time).
export function stockholmInstant(date: string, time: string) {
  const guess = new Date(`${date}T${time}:00Z`);
  const local = new Date(guess.toLocaleString('en-US', { timeZone: 'Europe/Stockholm' })), utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() - (local.getTime() - utc.getTime())).toISOString();
}
const addDays = (date: string, days: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

// A spoken clock time: "klockan 14", "kl. 9", "kl 14:30", "klockan 7.15". Hours 0-23 only; anything else is no time.
export function spokenTime(p: string): string | null {
  const m = p.toLocaleLowerCase('sv').match(/\b(?:klockan|kl)\.?\s*(\d{1,2})(?:[:.](\d{2}))?\b/);
  if (!m) return null;
  const h = Number(m[1]), min = m[2] === undefined ? 0 : Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// Applies a company's configured default time to a date-only deadline. The result is marked 'standard'.
export function withDefaultTime(d: Deadline, defaultTime: string | null): TimedDeadline {
  if (d.due_at || !defaultTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(defaultTime)) return d;
  return { ...d, time: defaultTime, due_at: stockholmInstant(d.date, defaultTime), time_source: 'standard' };
}

// Resolves a phrase such as "senast på fredag", "i morgon", "nästa vecka", "om tre dagar" or "den 5 december".
// Returns null when the phrase holds no date we can resolve without guessing.
export function resolveSwedishDeadline(phrase: string | null | undefined, callInstant: string): Deadline | null {
  if (!phrase) return null;
  const p = phrase.toLocaleLowerCase('sv').replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim(), today = stockholmDate(callInstant);
  const time = spokenTime(phrase);
  const done = (date: string, uncertain: string | null = null): Deadline => ({ date, time, due_at: time ? stockholmInstant(date, time) : null, time_source: time ? 'angiven' : null, uncertain });
  if (/\bi övermorgon\b|\bövermorgon\b/.test(p)) return done(addDays(today, 2));
  if (/\bi morgon\b|\bimorgon\b/.test(p)) return done(addDays(today, 1));
  if (/\bi dag\b|\bidag\b/.test(p)) return done(today);
  const inN = p.match(/\bom (\d{1,2}|[a-zåäö]+) (dag|dagar|vecka|veckor)\b/);
  if (inN) { const n = /^\d+$/.test(inN[1]!) ? Number(inN[1]) : NUMBERS[inN[1]!]; if (n) return done(addDays(today, inN[2]!.startsWith('veck') ? 7 * n : n)); }
  const explicit = p.match(/\b(?:den )?(\d{1,2})(?:e|a)? (januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)\b/);
  if (explicit) {
    const day = Number(explicit[1]), month = MONTHS.indexOf(explicit[2] as typeof MONTHS[number]) + 1, year = Number(today.slice(0, 4));
    let date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (Number.isNaN(Date.parse(`${date}T12:00:00Z`)) || new Date(`${date}T12:00:00Z`).getUTCDate() !== day) return null;
    if (date < today) date = `${year + 1}${date.slice(4)}`;
    return done(date);
  }
  if (/\bnästa vecka\b/.test(p) && !WEEKDAYS.some(w => p.includes(w))) return done(addDays(today, ((8 - weekday(today)) % 7) || 7));
  if (/\b(i )?slutet av veckan\b/.test(p)) { const ahead = (5 - weekday(today) + 7) % 7; return done(addDays(today, ahead)); }
  const day = WEEKDAYS.findIndex(w => new RegExp(`\\b${w}(en)?\\b`).test(p));
  if (day >= 0) {
    // "nästa <dag>": that day in the following (Monday-based) week.
    if (/\bnästa\b/.test(p)) {
      const monday = addDays(today, ((8 - weekday(today)) % 7) || 7);
      return done(addDays(monday, (day + 6) % 7));
    }
    const ahead = (day - weekday(today) + 7) % 7;
    // Said on the same weekday: the coming one, flagged for checking.
    if (ahead === 0) return done(addDays(today, 7), 'Samma veckodag som samtalet – kontrollera om det gäller idag eller nästa vecka.');
    return done(addDays(today, ahead));
  }
  return null;
}
