import { expect, it } from 'vitest';
import { companyLogoError, companyLogoPath, isCompanyLogoPath } from '@/lib/company-logo';
it('accepts supported logo images and rejects oversized or non-image uploads',()=>{
  for(const type of ['image/png','image/jpeg','image/webp']) expect(companyLogoError({type,size:5*1024*1024})).toBeNull();
  expect(companyLogoError({type:'image/png',size:5*1024*1024+1})).not.toBeNull();
  expect(companyLogoError({type:'image/svg+xml',size:100})).not.toBeNull();
  expect(companyLogoError({type:'image/png',size:0})).not.toBeNull();
});
it('rejects another company logo path and directory traversal before saving branding',()=>{
  const company='00000000-0000-4000-8000-000000000001', other='00000000-0000-4000-8000-000000000002';
  expect(isCompanyLogoPath(company,companyLogoPath(company,'image/png',other))).toBe(true);
  expect(isCompanyLogoPath(company,companyLogoPath(other,'image/png',company))).toBe(false);
  expect(isCompanyLogoPath(company,`${company}/../${other}/logo.png`)).toBe(false);
});
it('keeps each company logo under its own company folder with a correct image extension',()=>{
  expect(companyLogoPath('company-a','image/jpeg','file')).toBe('company-a/file.jpg');
  expect(companyLogoPath('company-b','image/png','file')).toBe('company-b/file.png');
});