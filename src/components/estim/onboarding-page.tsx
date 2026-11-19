import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { useWorkspace } from './workspace-provider';
import { PriceImport } from './price-import';

export function OnboardingPage(){const workspace=useWorkspace();return <main className="onboarding-page"><h1>{workspace.data?.company?'Företaget är klart':'Inbjudan krävs'}</h1>{workspace.loading?<p className="mt16">Läser dina uppgifter…</p>:!workspace.signedIn?<Link to="/auth" className="link mt16">Logga in</Link>:workspace.data?.company?<><p className="mt16 small muted">Valfritt steg: läs in priser från gamla fakturor. Du kan också göra det senare under AI och inställningar.</p><PriceImport/><Button asChild variant="prototype" className="btn btn-primary mt16"><Link to="/">Till inkorgen</Link></Button></>:workspace.data?.platform?<Link to="/admin" className="link mt16">Till administrationen</Link>:<p className="mt16">Acceptera din inbjudan för att öppna företagets inkorg.</p>}</main>;}