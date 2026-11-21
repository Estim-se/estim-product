import { createFileRoute } from '@tanstack/react-router';
import { PrototypePageShell } from '@/components/estim/prototype-page-shell';
import { TendersPage } from '@/components/estim/tenders-page';

export const Route = createFileRoute('/anbud')({
  head: () => ({ meta: [
    { title: 'estim · Anbud' },
    { name: 'description', content: 'Anbud och företagets privata anbudsunderlag.' },
    { property: 'og:title', content: 'estim · Anbud' },
    { property: 'og:description', content: 'Anbud och företagets privata anbudsunderlag.' },
    { property: 'og:type', content: 'website' },
    { name: 'twitter:card', content: 'summary_large_image' },
  ] }),
  component: () => <PrototypePageShell><TendersPage /></PrototypePageShell>,
});