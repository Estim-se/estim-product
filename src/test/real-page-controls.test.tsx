import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { EmailChannelCard } from '@/components/estim/email-channel-card';
import { RealChannels } from '@/components/estim/real-channels';
import { CompanyForm } from '@/components/estim/company-form';

const fixture = vi.hoisted(() => ({
  readEmail: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), saveWhatsApp: vi.fn(),
  mutate: vi.fn(), refresh: vi.fn(),
  role: 'ägare',
  sendingConnected: true,
  channels: [] as { type: string; phone_number_id: string }[],
}));
vi.mock('@/lib/email-client', () => ({ getEmailConnection: fixture.readEmail, startEmailConnect: fixture.connect, disconnectEmail: fixture.disconnect }));
vi.mock('@/lib/channel.functions', () => ({ saveWhatsAppChannel: fixture.saveWhatsApp }));
vi.mock('@tanstack/react-start', () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock('@/components/estim/top-header', () => ({ TopHeader: () => null }));
vi.mock('@/components/estim/workspace-provider', () => ({ useWorkspace: () => ({
  data: { company: { id: 'company-a', name: 'farax', signature: 'farax', reply_to_email: 'office@example.test', hourly_rate_ex_vat: 680, travel_fee: 450, settings: [true, true, false, true, true, true, false] }, profile: { display_name: 'Abdikarim' }, moments: [], channels: fixture.channels, role: fixture.role, whatsAppSendingConnected: fixture.sendingConnected },
  mutate: fixture.mutate, refresh: fixture.refresh,
}) }));
afterEach(() => { cleanup(); vi.resetAllMocks(); fixture.role = 'ägare'; fixture.channels = []; fixture.sendingConnected = true; });

describe('real page actions after presentation changes', () => {
  it('submits the same company changes from the save action outside the form', async () => {
    fixture.mutate.mockResolvedValue({}); fixture.refresh.mockResolvedValue(undefined);
    const target = document.createElement('div');
    document.body.append(target);
    try {
      const view = render(<CompanyForm activeSection="Priser" saveTarget={target} />);
      fireEvent.change(view.getByLabelText('Timpris exkl. moms'), { target: { value: '720' } });
      const button = target.querySelector('button');
      if (!button) throw new Error('Expected the external save action');
      fireEvent.click(button);
      await waitFor(() => expect(fixture.refresh).toHaveBeenCalledTimes(1));
      expect(fixture.mutate).toHaveBeenCalledWith({ kind: 'company', company: expect.objectContaining({ hourly_rate_ex_vat: 720 }) });
    } finally { target.remove(); }
  });
  it.each([[false, false], [true, false], [false, true], [true, true]])('toggles the connection form with configuration %s and company ID %s', (configured, hasId) => {
    fixture.sendingConnected = configured;
    fixture.channels = hasId ? [{ type: 'wa', phone_number_id: '1516723658186972' }] : [];
    fixture.readEmail.mockResolvedValue(null);
    const view = render(<RealChannels />);
    const toggle = view.getByRole('button', { name: 'Anslut WhatsApp' });
    expect(view.queryByLabelText('WhatsApp-ID')).toBeNull();
    fireEvent.click(toggle);
    expect(view.getByLabelText('WhatsApp-ID')).toBeDefined();
    fireEvent.click(toggle);
    expect(view.queryByLabelText('WhatsApp-ID')).toBeNull();
    fireEvent.click(toggle);
    fireEvent.click(view.getByRole('button', { name: 'Stäng' }));
    expect(view.queryByLabelText('WhatsApp-ID')).toBeNull();
    expect(fixture.saveWhatsApp).not.toHaveBeenCalled();
  });
  it.each(['användare', 'ägare'])('keeps technical fields collapsed for %s until opened', role => {
    fixture.role = role; fixture.readEmail.mockResolvedValue(null);
    const view = render(<RealChannels />);
    expect(view.queryByLabelText('WhatsApp-ID')).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Anslut WhatsApp' }));
    expect(view.getByLabelText('WhatsApp-ID')).toBeDefined();
  });
  it.each([['Google', 'google'], ['Microsoft 365', 'microsoft']])('keeps mailbox connection choice %s', async (label, provider) => {
    fixture.readEmail.mockResolvedValue(null);
    // Stop before navigating away to an external OAuth provider.
    fixture.connect.mockRejectedValue(new Error('Connection stopped for test'));
    const view = render(<EmailChannelCard isOwner />);
    fireEvent.click(await view.findByRole('button', { name: label }));
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledWith(provider));
  });
  it('disconnects only after the existing confirmation', async () => {
    fixture.readEmail.mockResolvedValue({ email: 'office@example.test', provider: 'google', status: 'active' });
    fixture.disconnect.mockResolvedValue({ ok: true });
    const view = render(<EmailChannelCard isOwner />);
    fireEvent.click(await view.findByRole('button', { name: /^Koppla från$/ }));
    expect(fixture.disconnect).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: /^Koppla från$/ }));
    await waitFor(() => expect(fixture.disconnect).toHaveBeenCalledTimes(1));
    await view.findByRole('button', { name: 'Google' });
  });
  it('does not expose mailbox connection controls to non-owners', async () => {
    fixture.readEmail.mockResolvedValue(null);
    const view = render(<EmailChannelCard isOwner={false} />);
    await waitFor(() => expect(fixture.readEmail).toHaveBeenCalled());
    expect(view.queryByRole('button')).toBeNull();
  });
  it('cancels disconnect without calling the service', async () => {
    fixture.readEmail.mockResolvedValue({ email: 'office@example.test', provider: 'microsoft', status: 'active' });
    const view = render(<EmailChannelCard isOwner />);
    fireEvent.click(await view.findByRole('button', { name: /^Koppla från$/ }));
    fireEvent.click(view.getByRole('button', { name: 'Avbryt' }));
    expect(fixture.disconnect).not.toHaveBeenCalled();
    expect(view.queryByRole('group')).toBeNull();
  });
  it('retains the mailbox and exposes a failed disconnect for retry', async () => {
    fixture.readEmail.mockResolvedValue({ email: 'office@example.test', provider: 'google', status: 'active' });
    fixture.disconnect.mockRejectedValue(new Error('Frånkopplingen misslyckades.'));
    const view = render(<EmailChannelCard isOwner />);
    fireEvent.click(await view.findByRole('button', { name: /^Koppla från$/ }));
    fireEvent.click(view.getByRole('button', { name: /^Koppla från$/ }));
    await view.findByRole('alert');
    expect(view.queryByRole('button', { name: 'Google' })).toBeNull();
    expect(view.getByRole('button', { name: /^Koppla från$/ }).hasAttribute('disabled')).toBe(false);
  });
  it('saves the entered WhatsApp identifier then refreshes', async () => {
    fixture.readEmail.mockResolvedValue(null); fixture.saveWhatsApp.mockResolvedValue({}); fixture.refresh.mockResolvedValue(undefined);
    const view = render(<RealChannels />);
    fireEvent.click(view.getByRole('button', { name: 'Anslut WhatsApp' }));
    fireEvent.change(view.getByLabelText('WhatsApp-ID'), { target: { value: '1516723658186972' } });
    fireEvent.click(view.getByRole('button', { name: 'Spara' }));
    await waitFor(() => expect(fixture.refresh).toHaveBeenCalledTimes(1));
    expect(fixture.saveWhatsApp).toHaveBeenCalledWith({ data: { phone_number_id: '1516723658186972' } });
  });
  it('retains the form checkbox change and explicit settings save', async () => {
    fixture.mutate.mockResolvedValue({}); fixture.refresh.mockResolvedValue(undefined);
    const view = render(<CompanyForm />);
    const checkbox = view.getAllByRole('checkbox')[0];
    if (!checkbox) throw new Error('Expected a company setting checkbox');
    fireEvent.click(checkbox);
    expect(fixture.mutate).not.toHaveBeenCalled();
    fireEvent.change(view.getByLabelText('Timpris exkl. moms'), { target: { value: '720' } });
    fireEvent.click(view.getByRole('button', { name: 'Spara inställningar' }));
    await waitFor(() => expect(fixture.refresh).toHaveBeenCalledTimes(1));
    expect(fixture.mutate).toHaveBeenCalledWith({ kind: 'profile', display_name: 'Abdikarim' });
    expect(fixture.mutate).toHaveBeenCalledWith({ kind: 'company', company: expect.objectContaining({ name: 'farax', hourly_rate_ex_vat: 720, settings: [false, true, false, true, true, true, false] }) });
  });
});