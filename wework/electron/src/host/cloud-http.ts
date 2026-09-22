import { net } from 'electron'

/**
 * Every main-process request to the Wegent cloud must use this implementation.
 *
 * Chromium's network stack resolves the proxy from the operating system and trusts the OS
 * certificate store, and it is the stack the renderer and the authorization window already use.
 * Node's global `fetch` (undici) ignores both, so a machine that reaches the backend only through a
 * system proxy, or only through an enterprise root certificate, completes the renderer steps of
 * desktop sign-in and then fails the authorization poll that runs in the main process.
 */
export const cloudFetch: typeof fetch = (input, init) =>
  net.fetch(typeof input === 'string' || input instanceof URL ? String(input) : input, init)
