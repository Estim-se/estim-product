import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuotePdf } from '@/components/estim/quote-pdf';
import { initialThreads } from '@/data/inbox';

vi.mock('@/components/estim/workspace-provider', () => ({ useWorkspace: () => ({ mode: 'demo', data: null }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.style.overflow = ''; });

function openPreview() {
  const thread = initialThreads().find(t => t.q);
  if (!thread) throw new Error('Missing quote fixture');
  const onClose = vi.fn();
  const opener = document.createElement('button');
  document.body.append(opener);
  opener.focus();
  const view = render(<QuotePdf thread={thread} onClose={onClose} />);
  return { ...view, onClose, opener, thread };
}

describe('Quote preview interactions', () => {
  it('locks page scrolling, traps focus, and restores the opener on close', () => {
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{ width: 10 }] as unknown as DOMRectList);
    document.body.style.overflow = 'auto';
    const { unmount, opener } = openPreview();
    expect(document.body.style.overflow).toBe('hidden');
    const download = screen.getByRole('button', { name: 'Ladda ner PDF' });
    const area = screen.getByLabelText('Offertdokument');
    expect(document.activeElement).toBe(download);
    fireEvent.keyDown(download, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(area);
    fireEvent.keyDown(area, { key: 'Tab' });
    expect(document.activeElement).toBe(download);
    opener.focus();
    expect(document.activeElement).toBe(download);
    unmount();
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe('auto');
    opener.remove();
  });

  it('closes through Escape, close button, and overlay without closing on document clicks', () => {
    const { onClose, opener } = openPreview();
    fireEvent.click(screen.getByLabelText('Offertdokument'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Stäng' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    const overlay = screen.getByRole('dialog').parentElement;
    if (!overlay) throw new Error('Missing overlay');
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(3);
    cleanup();
    opener.remove();
  });

  it('keeps the PDF download using the existing browser print handler', () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    const { opener } = openPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Ladda ner PDF' }));
    expect(print).toHaveBeenCalledTimes(1);
    cleanup();
    opener.remove();
  });
});