import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { useWorkspace } from './workspace-provider';

// Public demo surfaces remain accessible; real-company content requires a loaded identity.
export function WorkspaceAccess({children}:{children:ReactNode}){const workspace=useWorkspace();
 if(workspace.mode==='demo')return children;
 if(workspace.loading)return <div className="mt24" role="status">Läser företagets uppgifter…</div>;
 if(workspace.error)return <div className="mt24"><p role="alert">{workspace.error}</p><Button variant="prototype" className="btn btn-ghost mt16" onClick={()=>void workspace.refresh().catch(()=>{})}>Försök igen</Button></div>;
 if(!workspace.signedIn)return <div className="contents max-[960px]:flex max-[960px]:min-h-[calc(100dvh-98px-env(safe-area-inset-bottom))] max-[960px]:items-center max-[960px]:justify-center"><Button asChild variant="prototype" className="btn btn-primary mt24 max-[960px]:!mt-0"><Link to="/auth">Logga in</Link></Button></div>;
 if(!workspace.data?.company)return <div className="mt24"><h1>{workspace.data?.platform?'Administration':'Inbjudan krävs'}</h1>{workspace.data?.platform?<Button asChild variant="prototype" className="btn btn-primary mt16"><Link to="/admin">Till administrationen</Link></Button>:<p className="mt16">Acceptera din inbjudan för att öppna företagets inkorg.</p>}</div>;
 return children;
}