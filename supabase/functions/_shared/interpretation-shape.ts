// Model tool output is not guaranteed to follow the schema exactly (a list field can arrive as one string or be
// missing). Normalise list fields before code reads them, so drafting never crashes on a shape detail.

/** Returns the value as a list: arrays are kept, a non-empty string becomes one entry, anything else is empty. */
export function asList<T = string>(v: unknown): T[] {
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined) as T[];
  if (typeof v === "string" && v.trim()) return [v.trim() as unknown as T];
  return [];
}

const TEXT_LISTS = ["assumptions", "unclear", "follow_up_questions"] as const;
const OBJECT_LISTS = ["items", "risks", "customer_questions", "facts"] as const;

/** Normalises the list fields of an interpretation; other fields are left exactly as they are. */
export function normaliseInterpretation<T extends Record<string, unknown>>(d: T): T {
  const out: Record<string, unknown> = { ...d };
  for (const k of TEXT_LISTS) out[k] = asList<string>(d[k]).map(String);
  for (const k of OBJECT_LISTS) out[k] = asList<unknown>(d[k]).filter((x) => typeof x === "object");
  return out as T;
}
