// Shared-test safety proposal. A credential is never consent to use the application database.
export const SHARED_APPLICATION_REF = 'tjlbqmwwuifvjqdbwehx';
export type TestTarget = { mode: string | undefined; isolated: string | undefined; optIn: string | undefined; approvedRef: string | undefined; url: string | undefined };
export function approvedIntegrationTarget(target: TestTarget): boolean {
  if (target.mode !== 'remote') return false;
  if (target.optIn !== 'I_APPROVE_DISPOSABLE_TEST_PROJECT') throw new Error('remote_test_opt_in_required');
  if (!target.url || !target.approvedRef || target.approvedRef === SHARED_APPLICATION_REF) throw new Error('disposable_test_project_required');
  const url = new URL(target.url);
  if (url.protocol !== 'https:' || url.hostname !== `${target.approvedRef}.supabase.co` || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('unapproved_test_target');
  // Remote execution requires a separately provisioned target-only network sandbox; this local launcher never enables it.
  if (target.isolated !== 'target-only') throw new Error('remote_test_network_policy_required');
  return true;
}
export function requireLocalIsolation(env: Record<string, string | undefined>) {
  if (env['ESTIM_TEST_MODE'] !== 'local' || env['ESTIM_TEST_NET_ISOLATED'] !== '1') throw new Error('use_isolated_test_launcher');
}
export function integrationConfigured() {
  return approvedIntegrationTarget({ mode: process.env['ESTIM_TEST_MODE'], isolated: process.env['ESTIM_TEST_NET_ISOLATED'], optIn: process.env['ESTIM_REMOTE_TEST_OPT_IN'], approvedRef: process.env['ESTIM_DISPOSABLE_PROJECT_REF'], url: process.env['SUPABASE_URL'] });
}
