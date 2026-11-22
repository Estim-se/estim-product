export const COMPANY_LOGO_MAX_BYTES = 5 * 1024 * 1024;
export function companyLogoError(file: { type: string; size: number }) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return 'Välj en PNG-, JPG- eller WEBP-bild.';
  if (file.size <= 0 || file.size > COMPANY_LOGO_MAX_BYTES) return 'Logotypen får vara högst 5 MB.';
  return null;
}
export function companyLogoPath(companyId: string, type: string, id: string) {
  const extension = type === 'image/png' ? 'png' : type === 'image/jpeg' ? 'jpg' : 'webp';
  return `${companyId}/${id}.${extension}`;
}
export function isCompanyLogoPath(companyId: string, path: string) {
  return path.startsWith(`${companyId}/`) && /^[\da-f-]+\/[\da-f-]+\.(png|jpg|webp)$/.test(path);
}