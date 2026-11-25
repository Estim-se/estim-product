import { createFileRoute } from '@tanstack/react-router';
import { PrototypePageShell } from '@/components/estim/prototype-page-shell';
import { SamtalPage } from '@/components/estim/samtal-page';

// estim Samtal (flag SAMTAL): calls, tasks, phone numbers and settings.
export const Route = createFileRoute('/samtal')({
  head: () => ({ meta: [
    { title: 'estim · Samtal' },
    { name: 'description', content: 'Kundsamtal blir förfrågningar, uppgifter och offertutkast.' },
    { property: 'og:title', content: 'estim · Samtal' },
    { property: 'og:description', content: 'Kundsamtal blir förfrågningar, uppgifter och offertutkast.' },
    { property: 'og:type', content: 'website' },
    { name: 'twitter:card', content: 'summary_large_image' },
  ] }),
  component: () => <PrototypePageShell><SamtalPage /></PrototypePageShell>,
});
