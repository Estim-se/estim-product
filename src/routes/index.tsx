import { createFileRoute } from "@tanstack/react-router";
import { InboxScreen } from '@/components/estim/inbox-screen';

// The home route ships no og:image, so serve-time hosting can inject the
// project's social preview (explicit og:image or latest screenshot).
export const Route = createFileRoute("/")({
  head: () => ({ meta: [
    { title: 'estim · Inkorg' },
    { name: 'description', content: 'Alla kunder, alla kanaler. AI:n svarar, du godkänner.' },
    { property: 'og:title', content: 'estim · Inkorg' },
    { property: 'og:description', content: 'Alla kunder, alla kanaler. AI:n svarar, du godkänner.' },
    { property: 'og:type', content: 'website' },
    { name: 'twitter:card', content: 'summary_large_image' },
  ] }),
  component: InboxScreen,
});
