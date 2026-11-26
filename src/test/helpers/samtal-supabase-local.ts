// Test-only: a Supabase-shaped client over a disposable local PostgreSQL session (reads, RPCs and a fake private
// bucket). Never points at a real database.
import { scalar, type LocalSession } from './samtal-postgres-local';

type Result = { data: unknown; error: { code: string } | null };
export function supabaseOver(db: LocalSession, files: Map<string, Uint8Array>) {
  const sets = new Map<string, boolean>();
  const fail = (e: unknown): Result => ({ data: null, error: { code: String((e as { code?: string }).code ?? 'error') } });
  const rpc = async (name: string, args: Record<string, unknown>): Promise<Result> => {
    if (!/^[a-z_]+$/.test(name)) throw new Error('bad_rpc');
    try {
      if (!sets.has(name)) sets.set(name, await scalar<boolean>(db, "SELECT bool_or(proretset) AS v FROM pg_proc WHERE proname=$1 AND pronamespace='public'::regnamespace", [name]));
      const keys = Object.keys(args), call = `public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}${Array.isArray(args[k]) ? '::jsonb' : ''}`).join(',')})`, params = keys.map(k => args[k] === undefined ? null : args[k]);
      if (sets.get(name)) return { data: (await db.query(`SELECT * FROM ${call}`, params)).rows, error: null };
      return { data: (await db.query<{ v: unknown }>(`SELECT ${call} AS v`, params)).rows[0]?.v ?? null, error: null };
    } catch (e) { return fail(e); }
  };
  const from = (table: string) => {
    let cols = '*';
    const where: string[] = [], params: unknown[] = [], tail: string[] = [];
    const run = async (single: boolean): Promise<Result> => {
      try {
        const rows = (await db.query(`SELECT ${cols} FROM public.${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ${tail.join(' ')}`, params)).rows;
        return { data: single ? rows[0] ?? null : rows, error: null };
      } catch (e) { return fail(e); }
    };
    const chain = {
      select(c: string) { cols = c.split(',').map(s => s.trim()).filter(s => /^[a-z_]+$/.test(s)).join(',') || '*'; return chain; },
      eq(c: string, v: unknown) { params.push(v); where.push(`${c}=$${params.length}`); return chain; },
      in(c: string, v: unknown[]) { params.push(v); where.push(`${c}=ANY($${params.length})`); return chain; },
      order(c: string, o: { ascending?: boolean } = {}) { tail.unshift(`ORDER BY ${c} ${o.ascending === false ? 'DESC' : 'ASC'}`); return chain; },
      limit(n: number) { tail.push(`LIMIT ${Number(n)}`); return chain; },
      maybeSingle: () => run(true),
      then: (ok: (v: Result) => void, bad: (e: unknown) => void) => run(false).then(ok, bad),
    };
    return chain;
  };
  const storage = { from: () => ({
    upload: async (p: string, bytes: Uint8Array) => (files.set(p, bytes), { data: { path: p }, error: null }),
    download: async (p: string) => files.has(p) ? { data: { arrayBuffer: async () => files.get(p)!.slice().buffer }, error: null } : { data: null, error: { message: 'missing' } },
    remove: async (ps: string[]) => (ps.forEach(p => files.delete(p)), { data: [], error: null }),
    createSignedUrl: async (p: string) => ({ data: { signedUrl: `https://signed.invalid/${p}` }, error: null }),
  }) };
  return { rpc, from, storage };
}

