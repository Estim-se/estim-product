import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { CompanyAutoReply } from '@/components/estim/company-auto-reply';

const fixture = vi.hoisted(() => ({ enabled: false, mutate: vi.fn(), refresh: vi.fn() }));
vi.mock('@/components/estim/workspace-provider', () => ({
  useWorkspace: () => ({ data: { company: { whatsapp_auto_reply: fixture.enabled } }, mutate: fixture.mutate, refresh: fixture.refresh }),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); fixture.enabled = false; });
describe('company WhatsApp setting persistence', () => {
  it('does not submit unrelated company settings when embedded in their form', async () => {
    fixture.mutate.mockResolvedValue({}); fixture.refresh.mockResolvedValue(undefined);
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const view = render(<form onSubmit={submit}><CompanyAutoReply embedded /></form>);
    fireEvent.click(view.getByRole('switch'));
    await waitFor(() => expect(fixture.refresh).toHaveBeenCalledTimes(1));
    expect(fixture.mutate).toHaveBeenCalledExactlyOnceWith({ kind: 'whatsapp-auto', enabled: true });
    expect(submit).not.toHaveBeenCalled();
  });
  it('saves explicit on and off choices without modifying any threads', async () => {
    fixture.mutate.mockResolvedValue({}); fixture.refresh.mockResolvedValue(undefined);
    const view = render(<CompanyAutoReply />);
    fireEvent.click(view.getByRole('switch'));
    await waitFor(() => expect(fixture.refresh).toHaveBeenCalledTimes(1));
    expect(fixture.mutate).toHaveBeenCalledWith({ kind: 'whatsapp-auto', enabled: true });
    fixture.enabled = true; view.rerender(<CompanyAutoReply />);
    fireEvent.click(view.getByRole('switch'));
    await waitFor(() => expect(fixture.refresh).toHaveBeenCalledTimes(2));
    expect(fixture.mutate).toHaveBeenLastCalledWith({ kind: 'whatsapp-auto', enabled: false });
    expect(fixture.mutate).toHaveBeenCalledTimes(2);
  });
  it('does not reload or claim a saved setting when the write fails', async () => {
    fixture.mutate.mockRejectedValueOnce(new Error('Test failure'));
    const view = render(<CompanyAutoReply />);
    fireEvent.click(view.getByRole('switch'));
    await waitFor(() => expect(fixture.mutate).toHaveBeenCalledTimes(1));
    expect(fixture.refresh).not.toHaveBeenCalled();
  });
});