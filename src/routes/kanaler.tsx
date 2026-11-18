import { createFileRoute } from '@tanstack/react-router';
import { KanalerPage } from '@/components/estim/kanaler-page';
import { PrototypePageShell } from '@/components/estim/prototype-page-shell';

export const Route = createFileRoute('/kanaler')({
  head: () => ({ meta: [{ title: 'estim · Kanaler för Volt Vision' }, { name: 'description', content: 'Kunden skriver där den vill. Allt hamnar i samma inkorg och svaret går ut i samma kanal.' }, { property: 'og:title', content: 'estim · Kanaler för Volt Vision' }, { property: 'og:description', content: 'Kunden skriver där den vill. Allt hamnar i samma inkorg och svaret går ut i samma kanal.' }, { property: 'og:type', content: 'website' }, { name: 'twitter:card', content: 'summary_large_image' }] }),
  component: () => <PrototypePageShell><KanalerPage /></PrototypePageShell>,
});