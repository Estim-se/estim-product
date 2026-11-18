import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { supabase } from '@/integrations/supabase/client';
import { logoutEverywhere, acceptInvitation } from '@/lib/access.functions';
import { MIN_PASSWORD_LENGTH, parseAccept } from '@/lib/access-rules';
import { assertBoundedInput } from '@/lib/input-limits';
import { Button } from '@/components/ui/button';
import { useWorkspace } from './workspace-provider';
import { Logo } from './logo';

export function PasswordPage({ invitation = false }: { invitation?: boolean }) {
  const workspace = useWorkspace(), navigate = useNavigate();
  const accept = useServerFn(acceptInvitation), logout = useServerFn(logoutEverywhere);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [name, setName] = useState(''), [password, setPassword] = useState(''), [repeat, setRepeat] = useState('');
  useEffect(() => {
    let alive = true;
    async function resolve() {
      const query = new URLSearchParams(window.location.search), hash = new URLSearchParams(window.location.hash.slice(1));
      // Preserve the recovery marker after Supabase consumes the fragment.
      const recovery = hash.get('type') === 'recovery' || query.get('type') === 'recovery';
      if (!invitation && !recovery && !sessionStorage.getItem('estim-recovery')) throw new Error('Öppna återställningslänken från din e-post.');
      if (recovery) sessionStorage.setItem('estim-recovery', '1');
      if (query.get('code')) {
        const exchanged = await supabase.auth.exchangeCodeForSession(query.get('code') ?? '');
        if (exchanged.error) throw new Error('Länken är ogiltig eller har gått ut.');
      }
      const tokenHash = query.get('token_hash');
      if (tokenHash) {
        const verified = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: invitation ? 'invite' : 'recovery' });
        if (verified.error) throw new Error('Länken är ogiltig eller har gått ut.');
      }
      const user = await supabase.auth.getUser();
      if (!user.data.user) throw new Error('Länken är ogiltig eller har gått ut.');
      if (invitation && !query.get('token')) {
        const platform = await import('@/lib/access.functions');
        const access = await platform.loadAccess();
        if (!access.platform) throw new Error('Inbjudan saknas.');
      }
      if (alive) setReady(true);
    }
    void resolve().catch(e => { if (alive) setError(e instanceof Error ? e.message : 'Länken kunde inte öppnas.'); });
    return () => { alive = false; };
  }, [invitation]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      assertBoundedInput({ name, password, repeat });
      if (password.length < MIN_PASSWORD_LENGTH || password.length > 200 || password !== repeat) throw new Error('Lösenorden måste vara lika och ha minst 10 tecken.');
      const token = new URLSearchParams(window.location.search).get('token');
      if (invitation && token) await accept({ data: parseAccept({ token, name, password }) });
      else {
        const updated = await supabase.auth.updateUser({ password, ...(invitation ? { data: { display_name: name } } : {}) });
        if (updated.error) throw new Error('Lösenordet kunde inte sparas. Välj ett annat lösenord.');
        if (invitation) await workspace.mutate({ kind: 'profile', display_name: name });
        await logout();
      }
      sessionStorage.removeItem('estim-recovery');
      await workspace.signOut();
      await navigate({ to: '/auth', replace: true });
    } catch (e) { setError(e instanceof Error ? e.message : 'Kunde inte spara lösenordet.'); }
    finally { setBusy(false); }
  }
  return <main className="account-page"><Logo /><h1>{invitation ? 'Acceptera inbjudan' : 'Återställ lösenord'}</h1>{ready && <form className="account-form" onSubmit={submit}>{invitation && <label className="field">Visningsnamn<input className="input" value={name} onChange={e => setName(e.target.value)} maxLength={100} required autoComplete="name" /></label>}<label className="field">Nytt lösenord<input className="input" type="password" minLength={10} maxLength={200} value={password} onChange={e => setPassword(e.target.value)} required autoComplete="new-password" /></label><label className="field">Bekräfta lösenord<input className="input" type="password" minLength={10} maxLength={200} value={repeat} onChange={e => setRepeat(e.target.value)} required autoComplete="new-password" /></label><Button variant="prototype" className="btn btn-primary" disabled={busy} type="submit">{busy ? 'Sparar…' : invitation ? 'Acceptera och spara' : 'Spara lösenord'}</Button></form>}{error && <p role="alert">{error}</p>}<Link to="/auth" className="link">Till inloggningen</Link></main>;
}