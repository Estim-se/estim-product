import { createFileRoute } from '@tanstack/react-router';
import { MobilePage } from '@/components/estim/mobile-page';
import { PrototypePageShell } from '@/components/estim/prototype-page-shell';

export const Route = createFileRoute('/mobil')({
  head: () => ({ meta: [
    { title: 'estim · Appen i mobilen för Volt Vision' },
    { name: 'description', content: 'Byggd för dig som står på jobbet. Allt viktigt med en tumme.' },
    { property: 'og:title', content: 'estim · Appen i mobilen för Volt Vision' },
    { property: 'og:description', content: 'Byggd för dig som står på jobbet. Allt viktigt med en tumme.' },
    { property: 'og:type', content: 'website' },
    { name: 'twitter:card', content: 'summary_large_image' },
  ] }),
  component: () => <PrototypePageShell><MobilePage /></PrototypePageShell>,
});