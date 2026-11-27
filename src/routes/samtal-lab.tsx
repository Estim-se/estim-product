import { createFileRoute } from '@tanstack/react-router';
import { PrototypePageShell } from '@/components/estim/prototype-page-shell';
import { SamtalLabPage } from '@/features/samtal-lab/samtal-lab-page';

// Temporary internal demo; not linked from the menu. The shared shell keeps the normal sign-in requirement.
export const Route = createFileRoute('/samtal-lab')({
  head: () => ({ meta: [
    { title: 'estim · Samtal Test Lab' },
    { name: 'description', content: 'Intern demo: simulerad, regelbaserad analys av samtal.' },
    { name: 'robots', content: 'noindex' },
    { property: 'og:title', content: 'estim · Samtal Test Lab' },
    { property: 'og:description', content: 'Intern demo: simulerad, regelbaserad analys av samtal.' },
    { property: 'og:type', content: 'website' },
    { name: 'twitter:card', content: 'summary' },
  ] }),
  component: () => <PrototypePageShell><SamtalLabPage /></PrototypePageShell>,
});
