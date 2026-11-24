import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// On Windows a working directory with a lower-case drive letter ("c:\…", as some terminals give it) makes Vitest
// register vi.mock modules under another id than the one imports resolve to, so mocks silently do not apply. Use the
// upper-case drive letter everywhere so the tests behave the same in every terminal.
const upperDrive = (p: string) => (process.platform === "win32" ? p.replace(/^[a-z]:/, (d) => d.toUpperCase()) : p);
if (upperDrive(process.cwd()) !== process.cwd()) process.chdir(upperDrive(process.cwd()));
const root = upperDrive(__dirname);

export default defineConfig({
  root,
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
  resolve: {
    alias: { "@": path.resolve(root, "./src") },
  },
});
