/**
 * `server-only` is provided by the Next.js bundler, not by npm, so it does not
 * resolve under vitest. This stub stands in for it: the guard exists to stop a
 * server module being pulled into a client bundle, which a node test run
 * cannot do anyway.
 */
export {};
