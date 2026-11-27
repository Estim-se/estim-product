const MAX_NAME_CHARS = 80;

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  // Counted in code points so an emoji is never cut in half.
  return Array.from(trimmed).slice(0, MAX_NAME_CHARS).join('');
}

/**
 * Template data for the Supabase Auth invite mail ({{ .Data.inviter_name }}, {{ .Data.company_name }}).
 * Only non-empty, trimmed names capped at 80 characters. These keys are display-only: estim_new_profile reads
 * only display_name, and roles never come from user metadata.
 */
export function inviteTemplateData(inviterName: string | null | undefined, companyName: string | null | undefined) {
  const inviter = clean(inviterName);
  const company = clean(companyName);
  return {
    ...(inviter ? { inviter_name: inviter } : {}),
    ...(company ? { company_name: company } : {}),
  };
}
