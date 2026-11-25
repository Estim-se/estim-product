// Test helper only (never imported by an edge function): a small in-memory fake of the Supabase client calls the
// mail code uses, recording every call in order. Tests compare the recorded calls with a golden list (the proof that a
// flag that is off changes nothing) and check rows after a scenario.
//
// Supported: from(table).select(cols, { count: "exact", head: true }) / insert / update / upsert({ onConflict }) /
// delete, filters eq / is / gt / gte / lt / in / ilike / not(col, "in", "(a,b)") / contains, limit, maybeSingle,
// a chained .select() after a write, rpc(name, args), storage.from(bucket).upload and auth.admin.getUserById.
// Unique columns per table give a 23505 error like Postgres. fail() makes the next matching call return an error.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";

export type Row = Record<string, unknown>;
export interface DbError { code?: string; message: string }
export interface DbResult { data: unknown; error: DbError | null; count?: number | null }
type Filter = { text: string; test: (row: Row) => boolean };

const show = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

function likeToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\" && i + 1 < pattern.length) { out += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
    if (ch === "%") out += ".*";
    else if (ch === "_") out += ".";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

const compare = (a: unknown, b: unknown): number => (a === b ? 0 : (a as string) < (b as string) ? -1 : 1);

class Query implements PromiseLike<DbResult> {
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private cols = "*";
  private countHead = false;
  private payload: unknown = null;
  private onConflict: string | null = null;
  private returning = false;
  private single = false;
  private max: number | null = null;
  private filters: Filter[] = [];

  constructor(private db: FakeDb, private table: string) {}

  select(cols = "*", opts?: { count?: string; head?: boolean }): this {
    if (this.op === "select") { this.cols = cols; this.countHead = Boolean(opts?.head); }
    else { this.returning = true; this.cols = cols; }
    return this;
  }
  insert(rows: unknown): this { this.op = "insert"; this.payload = rows; return this; }
  update(patch: unknown): this { this.op = "update"; this.payload = patch; return this; }
  upsert(row: unknown, opts?: { onConflict?: string }): this { this.op = "upsert"; this.payload = row; this.onConflict = opts?.onConflict ?? "id"; return this; }
  delete(): this { this.op = "delete"; return this; }

  private add(text: string, test: (row: Row) => boolean): this { this.filters.push({ text, test }); return this; }
  eq(col: string, v: unknown) { return this.add(`.eq(${col},${show(v)})`, (r) => r[col] === v); }
  is(col: string, v: null) { return this.add(`.is(${col},${show(v)})`, (r) => r[col] == null); }
  gt(col: string, v: unknown) { return this.add(`.gt(${col},${show(v)})`, (r) => r[col] != null && compare(r[col], v) > 0); }
  gte(col: string, v: unknown) { return this.add(`.gte(${col},${show(v)})`, (r) => r[col] != null && compare(r[col], v) >= 0); }
  lt(col: string, v: unknown) { return this.add(`.lt(${col},${show(v)})`, (r) => r[col] != null && compare(r[col], v) < 0); }
  in(col: string, list: unknown[]) { return this.add(`.in(${col},${show(list)})`, (r) => list.includes(r[col])); }
  ilike(col: string, pattern: string) { const re = likeToRegExp(pattern); return this.add(`.ilike(${col},${pattern})`, (r) => typeof r[col] === "string" && re.test(r[col] as string)); }
  not(col: string, op: string, value: string) {
    if (op !== "in") throw new Error(`fake db: not(${op}) unsupported`);
    const list = value.replace(/^\(|\)$/g, "").split(",").map((s) => s.trim());
    return this.add(`.not(${col},in,${value})`, (r) => !list.includes(String(r[col])));
  }
  contains(col: string, obj: Record<string, unknown>) {
    return this.add(`.contains(${col},${show(obj)})`, (r) => {
      const v = r[col] as Record<string, unknown> | null | undefined;
      return Boolean(v) && Object.entries(obj).every(([k, x]) => JSON.stringify(v![k]) === JSON.stringify(x));
    });
  }
  limit(n: number): this { this.max = n; return this; }
  maybeSingle(): this { this.single = true; return this; }

  /** The call as recorded, e.g. `messages.select(id).eq(company_id,"c1").maybeSingle()`. */
  describe(): string {
    const head = this.op === "select"
      ? `${this.table}.select(${this.cols}${this.countHead ? ",count" : ""})`
      : this.op === "delete" ? `${this.table}.delete()`
      : `${this.table}.${this.op}(${show(this.payload)}${this.onConflict && this.op === "upsert" ? `,onConflict=${this.onConflict}` : ""})`;
    return head + this.filters.map((f) => f.text).join("") + (this.returning ? `.select(${this.cols})` : "") + (this.max != null ? `.limit(${this.max})` : "") + (this.single ? ".maybeSingle()" : "");
  }

  then<A = DbResult, B = never>(ok?: ((v: DbResult) => A | PromiseLike<A>) | null, err?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve().then(() => this.db.execute(this.describe(), () => this.run())).then(ok, err);
  }

  private matches(): Row[] {
    const rows = (this.db.tables[this.table] ??= []).filter((r) => this.filters.every((f) => f.test(r)));
    return this.max != null ? rows.slice(0, this.max) : rows;
  }
  private project(row: Row): Row {
    if (this.cols.trim() === "*") return { ...row };
    return Object.fromEntries(this.cols.split(",").map((c) => c.trim()).filter(Boolean).map((c) => [c, row[c] ?? null]));
  }
  private shape(rows: Row[], returning: boolean): DbResult {
    if (!returning) return { data: null, error: null };
    const out = rows.map((r) => this.project(r));
    if (this.single) {
      if (out.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
      return { data: out[0] ?? null, error: null };
    }
    return { data: out, error: null };
  }

  private run(): DbResult {
    const table = (this.db.tables[this.table] ??= []);
    if (this.op === "select") {
      const rows = this.matches();
      if (this.countHead) return { data: null, error: null, count: rows.length };
      return this.shape(rows, true);
    }
    if (this.op === "delete") {
      const gone = new Set(this.matches());
      this.db.tables[this.table] = table.filter((r) => !gone.has(r));
      return this.shape([...gone], this.returning);
    }
    if (this.op === "update") {
      const rows = this.matches();
      for (const r of rows) {
        const clash = this.db.uniqueClash(this.table, { ...r, ...(this.payload as Row) }, r);
        if (clash) return clash;
      }
      for (const r of rows) Object.assign(r, this.payload as Row);
      return this.shape(rows, this.returning);
    }
    const list = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
    const done: Row[] = [];
    for (const incoming of list) {
      const conflictCols = this.op === "upsert" ? this.onConflict!.split(",").map((c) => c.trim()) : [];
      const existing = conflictCols.length ? table.find((r) => conflictCols.every((c) => r[c] === incoming[c])) : undefined;
      if (existing) {
        const clash = this.db.uniqueClash(this.table, { ...existing, ...incoming }, existing);
        if (clash) return clash;
        Object.assign(existing, incoming);
        done.push(existing);
        continue;
      }
      const row: Row = { id: this.db.nextId(this.table), ...incoming };
      const clash = this.db.uniqueClash(this.table, row, null);
      if (clash) return clash;
      table.push(row);
      done.push(row);
    }
    return this.shape(done, this.returning);
  }
}

export class FakeDb {
  tables: Record<string, Row[]> = {};
  /** Every call in order: queries, rpc, storage, auth, and notes added by the test (e.g. fetch calls). */
  calls: string[] = [];
  /** Unique columns per table (each entry is one unique column). */
  unique: Record<string, string[]> = {};
  rpcs: Record<string, (args: Record<string, unknown>) => DbResult> = {};
  users: Record<string, string> = {};
  private failures: { match: string | RegExp; error: DbError; times: number }[] = [];
  private ids = 0;

  constructor(init?: { tables?: Record<string, Row[]>; unique?: Record<string, string[]> }) {
    if (init?.tables) for (const [t, rows] of Object.entries(init.tables)) this.tables[t] = rows.map((r) => ({ ...r }));
    if (init?.unique) this.unique = init.unique;
  }

  from(table: string): Query { return new Query(this, table); }

  rpc(name: string, args: Record<string, unknown> = {}): PromiseLike<DbResult> {
    return Promise.resolve().then(() => this.execute(`rpc.${name}(${show(args)})`, () => this.rpcs[name]?.(args) ?? { data: null, error: null }));
  }

  storage = {
    from: (bucket: string) => ({
      upload: (path: string, bytes: Uint8Array, opts?: { contentType?: string; upsert?: boolean }) =>
        Promise.resolve().then(() => this.execute(`storage.${bucket}.upload(${path},${bytes.length},${opts?.contentType ?? ""})`, () => ({ data: { path }, error: null }))),
    }),
  };

  auth = {
    admin: {
      getUserById: (id: string) => Promise.resolve().then(() => {
        this.calls.push(`auth.getUserById(${id})`);
        const email = this.users[id];
        return { data: { user: email ? { id, email } : null }, error: email ? null : { message: "not found" } };
      }),
    },
  };

  /** The next `times` calls whose description contains `match` (or matches the RegExp) return `error`. */
  fail(match: string | RegExp, error: DbError = { code: "XX000", message: "fake failure" }, times = 1): void {
    this.failures.push({ match, error, times });
  }

  /** Adds a line to the call log (for calls outside the database, e.g. a stubbed fetch). */
  note(line: string): void { this.calls.push(line); }

  /** The call log with ISO timestamps replaced by <ts>, so a golden list does not depend on the clock. */
  normalized(): string[] {
    return this.calls.map((c) => c.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<ts>"));
  }

  rows(table: string): Row[] { return this.tables[table] ?? []; }

  /** @internal */
  execute(description: string, run: () => DbResult): DbResult {
    this.calls.push(description);
    const i = this.failures.findIndex((f) => (typeof f.match === "string" ? description.includes(f.match) : f.match.test(description)));
    if (i >= 0) {
      const f = this.failures[i]!;
      if (--f.times <= 0) this.failures.splice(i, 1);
      return { data: null, error: f.error, count: null };
    }
    return run();
  }

  /** @internal */
  nextId(table: string): string { return `${table}_${++this.ids}`; }

  /** @internal A 23505 error when `row` would duplicate a unique column of another row. */
  uniqueClash(table: string, row: Row, self: Row | null): DbResult | null {
    for (const col of this.unique[table] ?? []) {
      if (row[col] == null) continue;
      if ((this.tables[table] ?? []).some((r) => r !== self && r[col] === row[col])) {
        return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint on ${col}` } };
      }
    }
    return null;
  }
}

/** The fake typed as the Supabase client the mail code takes. */
export const asClient = (db: FakeDb): SupabaseClient => db as unknown as SupabaseClient;
