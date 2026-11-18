import { describe, expect, it } from 'vitest';
import { canManageCompany, invitationStatus, parseLogin, parseAccept, INVITATION_DAYS } from '@/lib/access-rules';
describe('R1b access rules', () => {
  it('binds owners to their own company', () => { expect(canManageCompany(false, { company_id: 'a', role: 'ägare' }, 'b')).toBe(false); expect(canManageCompany(false, { company_id: 'a', role: 'ägare' }, 'a')).toBe(true); });
  it('denies administration to company users', () => { expect(canManageCompany(false, { company_id: 'a', role: 'användare' }, 'a')).toBe(false); });
  it('permits platform administration', () => { expect(canManageCompany(true, null, 'b')).toBe(true); });
  it('requires passwords with at least ten characters', () => { expect(() => parseLogin({ email: 'a@example.com', password: '123456789' })).toThrow(); expect(parseLogin({ email: 'a@example.com', password: '1234567890' }).password).toHaveLength(10); });
  it('uses seven-day invitations', () => { expect(INVITATION_DAYS).toBe(7); });
  it('rejects an invitation at its exact expiry', () => { expect(invitationStatus({ accepted_at: null, revoked_at: null, expires_at: '2026-11-18T00:00:00Z' }, Date.parse('2026-11-18T00:00:00Z'))).toBe('Utgången'); });
  it('rejects revoked invitations', () => { expect(invitationStatus({ accepted_at: null, revoked_at: '2026-11-17', expires_at: '2026-11-25' }, Date.parse('2026-11-18'))).toBe('Återkallad'); });
  it('rejects previously accepted invitations', () => { expect(invitationStatus({ accepted_at: '2026-11-17', revoked_at: null, expires_at: '2026-11-25' })).toBe('Accepterad'); });
  it('bounds invitation inputs before validation', () => { expect(() => parseAccept({ token: 'a'.repeat(64), name: 'a'.repeat(30001), password: '1234567890' })).toThrow(); });
});