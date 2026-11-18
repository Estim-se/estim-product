import { createFileRoute } from '@tanstack/react-router';
import { OfferterPage } from '@/components/estim/offerter-page';
import { PrototypePageShell } from '@/components/estim/prototype-page-shell';

export const Route = createFileRoute('/offerter')({
  head: () => ({ meta: [{ title: 'estim · Offerter för Volt Vision' }, { name: 'description', content: 'Alla offerter på ett ställe. Klicka för att se hela konversationen.' }, { property: 'og:title', content: 'estim · Offerter för Volt Vision' }, { property: 'og:description', content: 'Alla offerter på ett ställe. Klicka för att se hela konversationen.' }, { property: 'og:type', content: 'website' }, { name: 'twitter:card', content: 'summary_large_image' }] }),
  component: () => <PrototypePageShell><OfferterPage /></PrototypePageShell>,
});