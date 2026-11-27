import { defineConfig } from 'vitest/config';
import base from './vitest.config';

// This replaces discovery only for the explicit opt-in suite; required CI keeps its original glob.
export default defineConfig({
  ...base,
  test: { ...base.test, include: ['docs/samtal/tests/**/*.{test,spec}.{ts,tsx}'] },
});