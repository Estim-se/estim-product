// Restrict diagnostics to structural information; provider errors can contain personal data.
export function receiveFailureDetails(stage: string, error: unknown) {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const fields = ['channel', 'phone_number_id', 'customer_phone', 'customer_email', 'customer_name', 'text', 'provider_message_id', 'sent_at'];
  const issues = Array.isArray(value['issues']) ? value['issues'].slice(0, 10).map(issue => {
    const item = issue && typeof issue === 'object' ? issue as Record<string, unknown> : {};
    const path = Array.isArray(item['path']) ? item['path'][0] : undefined;
    return {
      field: typeof path === 'string' && fields.includes(path) ? path : 'body',
      code: typeof item['code'] === 'string' && /^[a-z_]{1,40}$/.test(item['code']) ? item['code'] : 'invalid',
    };
  }) : [];
  return {
    stage,
    kind: error instanceof SyntaxError ? 'invalid_json' : issues.length ? 'invalid_input'
      : error instanceof Error && error.message.startsWith('Uppgifterna är för stora') ? 'too_large' : 'server_error',
    code: typeof value['code'] === 'string' && /^(?:[A-Z0-9]{5}|PGRST\d{3})$/.test(value['code']) ? value['code'] : undefined,
    issues,
  };
}