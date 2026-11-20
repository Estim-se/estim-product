import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { AppShell } from '@/components/estim/app-shell';

const fixture = vi.hoisted(() => ({
  mode: 'real', signedIn: true, platform: true,
  setMode: vi.fn(), signOut: vi.fn(), openMobile: vi.fn(), reset: vi.fn(), navigate: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: '/kanaler' }),
  useNavigate: () => fixture.navigate,
  Link: ({ to, activeOptions, activeProps, ...props }: { to: string; activeOptions?: unknown; activeProps?: unknown }) => <a href={to} {...props} />,
}));
vi.mock('@/components/estim/store-provider', () => ({ useEstim: () => ({ actions: { openMobile: fixture.openMobile } }) }));
vi.mock('@/components/estim/workspace-provider', () => ({ useWorkspace: () => ({
  mode: fixture.mode, signedIn: fixture.signedIn, loading: false,
  data: { company: { name: 'Testbolag' }, platform: fixture.platform },
  setMode: fixture.setMode, signOut: fixture.signOut,
}) }));
// Render the menu inline so action wiring is tested independently of positioning.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => <div role="menu">{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({ children, onSelect, asChild }: React.PropsWithChildren<{ onSelect?: () => void; asChild?: boolean }>) => asChild ? <>{children}</> : <button type="button" role="menuitem" onClick={onSelect}>{children}</button>,
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); fixture.mode = 'real'; fixture.signedIn = true; fixture.platform = true; });

describe('mobile actions outside the workspace access gate', () => {
  it('retains logout, authorized administration and the phone return path', () => {
    const view = render(<AppShell waiting={0} onReset={fixture.reset}>Content</AppShell>);
    const menu = view.getByRole('menu');
    fireEvent.click(view.getByRole('menuitem', { name: 'Logga ut' }));
    expect(fixture.signOut).toHaveBeenCalledTimes(1);
    expect(menu.querySelector('a[href="/admin"]')).not.toBeNull();
    const mobile = menu.querySelector('a[href="/mobil"]');
    if (!mobile) throw new Error('Missing phone link');
    fireEvent.click(mobile);
    expect(fixture.openMobile).toHaveBeenCalledWith('/kanaler');
  });
  it('allows signed-in visitors to return to Demo without exposing administration to ordinary members', () => {
    fixture.platform = false;
    const view = render(<AppShell waiting={0} onReset={fixture.reset}>Content</AppShell>);
    fireEvent.click(view.getByRole('menuitem', { name: 'Demo' }));
    expect(fixture.setMode).toHaveBeenCalledWith('demo');
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(view.getByRole('menu').querySelector('a[href="/admin"]')).toBeNull();
  });
  it.each(['real', 'demo'])('preserves the main project login requirement in %s mode', mode => {
    fixture.mode = mode; fixture.signedIn = false;
    const view = render(<AppShell waiting={0} onReset={fixture.reset}>Content</AppShell>);
    expect(fixture.navigate).toHaveBeenCalledWith({ to: '/auth', replace: true });
    expect(view.queryByRole('menu')).toBeNull();
  });
});