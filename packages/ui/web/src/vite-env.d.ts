/// <reference types="vite/client" />

// `@fontsource-variable/jetbrains-mono` ships CSS only — no TypeScript
// types — so the side-effect import in `main.tsx` would otherwise fail
// the build. Declare it as a wildcard module to keep tsc quiet.
declare module "@fontsource-variable/jetbrains-mono";
