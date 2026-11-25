// Edge Functions import supabase-js through Deno's npm: specifier. Shared edge modules that the app and its tests also
// import use it for types only; this maps it to the same package for the TypeScript checker.
declare module 'npm:@supabase/supabase-js@2.119.0' {
  export * from '@supabase/supabase-js';
}
