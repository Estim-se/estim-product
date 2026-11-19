// An explicit thread choice wins; otherwise the thread follows its company.
export function whatsappAutoReply(companyEnabled: boolean, override: boolean | null | undefined) {
  return override ?? companyEnabled;
}