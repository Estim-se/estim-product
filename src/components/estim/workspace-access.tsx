import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { useWorkspace } from './workspace-provider';

// Public demo surfaces remain accessible; real-company content requires a loaded identity.
export function WorkspaceAccess({children}:{children:ReactNode}){const workspace=useWorkspace();
 if(workspace.mode==='demo')return children;
 if(workspace.loading)return <div className="mt24" role="status">Läser företagets uppgifter…</div>;
 if(workspace.error)return <div className="mt24"><p role="alert">{workspace.error}</p><Button variant="prototype" className="btn btn-ghost mt16" onClick={()=>void workspace.refresh().catch(()=>{})}>Försök igen</Button></div>;
 if(!workspace.signedIn)return <Button asChild variant="prototype" className="btn btn-primary mt24"><Link to="/auth">Logga in</Link></Button>;
 if(!workspace.data?.company)return <div className="mt24"><h1>Skapa ditt företag</h1><Button asChild variant="prototype" className="btn btn-primary mt16"><Link to="/onboarding">Företagsuppgifter</Link></Button></div>;
 return children;
}