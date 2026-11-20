import { defineConfig } from 'drizzle-kit';

// Metadata checks do not require a database connection or credentials.
export default defineConfig({
  dialect: 'postgresql',
  schema: './drizzle/schema.ts',
  out: './drizzle/migrations',
});