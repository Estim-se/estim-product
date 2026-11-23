import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { initialThreads } from '@/data/inbox';
import { Conversation } from '@/components/estim/conversation';

vi.mock('@/components/estim/store-provider', () => ({ useEstim: () => ({ state: { drafts: {} } }) }));
vi.mock('@/components/estim/message', () => ({ Message: () => null }));
vi.mock('@/components/estim/status-card', () => ({ StatusCard: () => null }));
vi.mock('@/components/estim/composer', () => ({ Composer: () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('contained conversation scrolling', () => {
  it('does not jump on incoming messages while reading older messages', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const thread = initialThreads()[0];
    if (!thread) throw new Error('Missing demo thread');
    const view = render(<Conversation thread={thread} contained />);
    const region = view.getByRole('region', { name: 'Meddelanden' });
    Object.defineProperties(region, { clientHeight: { value: 400 }, scrollHeight: { value: 1400 } });
    region.scrollTop = 200;
    fireEvent.scroll(region);
    const next = { ...thread, msgs: [...thread.msgs, { from: 'kund', time: '12:01', text: 'Nytt svar' }] };
    view.rerender(<Conversation thread={next} contained />);
    await waitFor(() => expect(region.scrollTop).toBe(200));
    fireEvent.click(view.getByRole('button', { name: 'Nytt meddelande, gå till senaste meddelandet' }));
    expect(region.scrollTop).toBe(1400);
    region.scrollTop = 1000;
    fireEvent.scroll(region);
    view.rerender(<Conversation thread={{ ...next, msgs: [...next.msgs, { from: 'kund', time: '12:02', text: 'Ännu ett svar' }] }} contained />);
    await waitFor(() => expect(region.scrollTop).toBe(1400));
    expect(view.queryByRole('button')).toBeNull();
  });
  it('offers a jump to the end only after scrolling well above it', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const thread = initialThreads()[0];
    if (!thread) throw new Error('Missing demo thread');
    const view = render(<Conversation thread={thread} contained />);
    const region = view.getByRole('region', { name: 'Meddelanden' });
    Object.defineProperties(region, { clientHeight: { value: 400 }, scrollHeight: { value: 1400 } });
    region.scrollTop = 900;
    fireEvent.scroll(region);
    expect(view.queryByRole('button', { name: 'Till slutet av konversationen' })).toBeNull();
    region.scrollTop = 200;
    fireEvent.scroll(region);
    fireEvent.click(view.getByRole('button', { name: 'Till slutet av konversationen' }));
    expect(region.scrollTop).toBe(1400);
  });
});