/** Keep filesystem-only workers independent of Electron's browser process. */
export const cloudFetch: typeof fetch = async (...args) => {
  const transport = await import('./cloud-http.js')
  return transport.cloudFetch(...args)
}
