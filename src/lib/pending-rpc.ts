// TEMPORARY bridge for database functions that are specified but not yet created by Lovable.
// Once the migration has run and src/integrations/supabase/types.ts is regenerated, replace every
// pendingRpc(db, name, args) with db.rpc(name, args) and delete this file.
type PendingFunctions = {
  estim_set_won: { args: { tid: string; won: boolean }; returns: string };
  estim_split_thread: { args: { tid: string; mid: string }; returns: { id: string; job_id: string } };
  estim_merge_customers: { args: { keep_id: string; drop_id: string }; returns: string };
};
type RpcResult<T> = { data: T | null; error: { message: string; code?: string } | null };
type RpcClient = { rpc: (name: string, args: unknown) => PromiseLike<RpcResult<unknown>> };

export async function pendingRpc<K extends keyof PendingFunctions>(db: object, name: K, args: PendingFunctions[K]['args']): Promise<RpcResult<PendingFunctions[K]['returns']>> {
  return await (db as RpcClient).rpc(name, args) as RpcResult<PendingFunctions[K]['returns']>;
}
