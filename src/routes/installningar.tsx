import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@/components/estim/settings-page';
import { PrototypePageShell } from '@/components/estim/prototype-page-shell';

export const Route = createFileRoute('/installningar')({
  head: () => ({ meta: [{ title: 'estim · Inställningar' }, { name: 'description', content: 'Bestäm vad AI:n får göra själv och hur den låter.' }, { property: 'og:title', content: 'estim · Inställningar' }, { property: 'og:description', content: 'Bestäm vad AI:n får göra själv och hur den låter.' }, { property: 'og:type', content: 'website' }, { name: 'twitter:card', content: 'summary_large_image' }] }),
  component: () => <PrototypePageShell><SettingsPage /></PrototypePageShell>,
});