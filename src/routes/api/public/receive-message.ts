import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/public/receive-message')({
  server: { handlers: { POST: async () => Response.json({ error: 'Åtkomst nekad.' }, { status: 401 }) } },
});