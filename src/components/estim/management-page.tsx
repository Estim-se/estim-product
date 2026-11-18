import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { loadManagement, manageAccess } from '@/lib/access.functions';
import { invitationStatus, parseManagement, type ManagementInput } from '@/lib/access-rules';
import { useWorkspace } from './workspace-provider';
import { Icon } from './icon';

export function ManagementPage({ companyId }: { companyId?: string }) {
  const workspace = useWorkspace();
  const read = useServerFn(loadManagement), write = useServerFn(manageAccess);
  const query = useQuery({ queryKey: ['management', companyId ?? 'platform'], queryFn: () => read({ data: companyId ? { companyId } : {} }), enabled: workspace.signedIn && workspace.mode === 'real', retry: false });
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [name, setName] = useState(''), [email, setEmail] = useState('');
  async function act(input: ManagementInput) {
    setBusy(true); setMessage('');
    try { await write({ data: parseManagement(input) }); setMessage('Ändringen är sparad.'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Ändringen kunde inte sparas.'); }
    finally { await query.refetch(); setBusy(false); }
  }
  function create(event: FormEvent) { event.preventDefault(); void act({ kind: 'company', name, email }); }
  if (!workspace.signedIn) return <main className="onboarding-page"><h1>Logga in</h1><Link to="/auth" className="link mt16">Till inloggningen</Link></main>;
  if (workspace.mode !== 'real') return <main className="onboarding-page"><h1>Administration</h1><Button variant="prototype" className="btn btn-primary mt16" onClick={() => workspace.setMode('real')}>Verkligt läge</Button></main>;
  if (query.isPending) return <p className="mt24" role="status">Läser uppgifter…</p>;
  if (query.error) return <main className="onboarding-page"><h1>Du saknar behörighet</h1><Link to="/" className="link mt16">Till inkorgen</Link></main>;
  return <div className={companyId ? 'management mt24' : 'management onboarding-page'}>
    <div className="row between wrap"><h1>{companyId ? 'Team' : 'Administration'}</h1>{!companyId && <div className="row wrap"><Link to="/" className="link">Till inkorgen</Link><Button variant="prototype" className="btn btn-ghost btn-sm" onClick={() => void workspace.signOut()}>Logga ut</Button></div>}</div>
    {!companyId && <form className="management-create mt24" onSubmit={create}><h2>Skapa företag och bjud in ägare</h2><div className="grid2 mt16"><label className="field">Företagsnamn<input className="input" required maxLength={200} value={name} onChange={e => setName(e.target.value)} /></label><label className="field">Ägarens e-post<input className="input" type="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} /></label></div><Button variant="prototype" className="btn btn-primary mt16" disabled={busy} type="submit"><Icon name="plus" />Skapa och bjud in</Button></form>}
    {message && <p role="status" className="mt16">{message}</p>}
    {query.data?.map(company => <section key={company.id} className="management-company mt32">
      <div className="row between wrap"><h2>{company.name}</h2><div className="row wrap"><span className={`chip ${company.active ? 'chip-sage' : 'chip-pink'}`}>{company.active ? 'Aktivt' : 'Avaktiverat'}</span>{!companyId && <Button variant="prototype" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act({ kind: 'active', companyId: company.id, active: !company.active })}>{company.active ? 'Avaktivera' : 'Aktivera'}</Button>}</div></div>
      <p className="muted small mt8">{company.requests} förfrågningar · Senast aktiv {new Date(company.activity).toLocaleString('sv-SE')}</p>
      <h3 className="mt24">Medlemmar</h3>
      {!company.members.length && <p className="muted small mt8">Inga medlemmar ännu.</p>}
      {company.members.map(member => <div className="management-row" key={member.user_id}><div className="grow"><b>{member.name || member.email}</b><div className="muted small">{member.email}</div></div><label className="field"><span className="sr-only">Roll för {member.email}</span><select className="input sm" value={member.role} disabled={busy} onChange={e => void act({ kind: 'member', companyId: company.id, userId: member.user_id, role: e.target.value as 'ägare' | 'användare' })}><option value="ägare">Ägare</option><option value="användare">Användare</option></select></label><Button variant="prototype" className="xbtn" title={`Ta bort ${member.email}`} aria-label={`Ta bort ${member.email}`} disabled={busy} onClick={() => { if (window.confirm(`Ta bort ${member.name || member.email} från företaget?`)) void act({ kind: 'member', companyId: company.id, userId: member.user_id, role: null }); }}><Icon name="close" /></Button></div>)}
      <InviteForm companyId={company.id} platform={!companyId} busy={busy || !company.active} onInvite={act} />
      <h3 className="mt24">Inbjudningar</h3>
      {!company.invitations.length && <p className="muted small mt8">Inga inbjudningar.</p>}
      {company.invitations.map(invitation => <div className="management-row" key={invitation.id}><div className="grow"><b>{invitation.email}</b><div className="small muted">{invitation.role === 'ägare' ? 'Ägare' : 'Användare'} · Gäller till {new Date(invitation.expires_at).toLocaleDateString('sv-SE')}</div></div><span className="chip chip-line">{invitationStatus(invitation)}</span>{!invitation.accepted_at && !invitation.revoked_at && <div className="row wrap"><Button variant="prototype" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act({ kind: 'resend', companyId: company.id, id: invitation.id })}>Skicka igen</Button><Button variant="prototype" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act({ kind: 'revoke', companyId: company.id, id: invitation.id })}>Återkalla</Button></div>}</div>)}
      {!companyId && <><h3 className="mt24">Händelser</h3>{company.audit.map(event => <div className="management-row small" key={event.id}><span className="grow">{event.event}{event.actor_name ? ` av ${event.actor_name}` : ''}</span><time>{new Date(event.created_at).toLocaleString('sv-SE')}</time></div>)}</>}
    </section>)}
  </div>;
}

function InviteForm({ companyId, platform, busy, onInvite }: { companyId: string; platform: boolean; busy: boolean; onInvite: (input: ManagementInput) => Promise<void> }) {
  const [email, setEmail] = useState(''), [role, setRole] = useState<'ägare' | 'användare'>('användare');
  return <form className="management-invite mt24" onSubmit={e => { e.preventDefault(); void onInvite({ kind: 'invite', companyId, email, role }); }}><label className="field">Bjud in användare<input className="input" type="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" /></label>{platform && <label className="field">Roll<select className="input" value={role} onChange={e => setRole(e.target.value as 'ägare' | 'användare')}><option value="användare">Användare</option><option value="ägare">Ägare</option></select></label>}<Button variant="prototype" className="btn btn-primary" type="submit" disabled={busy}><Icon name="plus" />Bjud in</Button></form>;
}