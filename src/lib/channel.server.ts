// Dispatch to the existing Edge worker, which owns background task lifetime.
export async function dispatchAiJob(jobId: string) {
  const url = process.env['SUPABASE_URL'];
  const secret = process.env['ESTIM_AI_JOB_SECRET'];
  if (!url || !secret) throw new Error('AI kunde inte svara just nu');
  const response = await fetch(`${url}/functions/v1/interpret-request`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-estim-job-secret': secret },
    body: JSON.stringify({ start_job: jobId }), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('AI kunde inte svara just nu');
}