/** Replaced at build time by Vite's `define` (root package.json version). */
declare const __APP_VERSION__: string | null | undefined;

/** App version shown in the UI, inlined at build time so startup needs no `/api/version` request. */
export const APP_VERSION: string | null =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : null;
