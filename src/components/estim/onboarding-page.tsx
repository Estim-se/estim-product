import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { useWorkspace } from './workspace-provider';
import { CompanyForm } from './company-form';

export function OnboardingPage(){const workspace=useWorkspace();return <main className="onboarding-page"><h1>{workspace.data?.company?'Företaget är klart':'Skapa ditt företag'}</h1>{workspace.loading?<p className="mt16">Läser dina uppgifter…</p>:!workspace.signedIn?<Link to="/auth" className="link mt16">Logga in</Link>:workspace.data?.company?<Button asChild variant="prototype" className="btn btn-primary mt16"><Link to="/">Till inkorgen</Link></Button>:<CompanyForm onboarding/>}</main>;}