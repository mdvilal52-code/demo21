// Vitest runs plain Node, without Next.js's bundler-level "server-only"
// enforcement. This stub replaces the real `server-only` package (see
// vitest.config.ts alias) purely for the test run — production builds still
// use the real package, which is what actually guards against a client
// bundle accidentally pulling in server-only code.
export {};
