import { getErrorMessage } from '@/lib/error-message'

/** Classify remote failures without exposing response bodies to the UI. */
export function remoteCatalogErrorKind(error: unknown): 'blocked' | 'auth' | 'timeout' | 'failed' {
  const message = getErrorMessage(error, '')
  if (/403|cloudflare|cf-chl|challenge-platform/i.test(message)) return 'blocked'
  if (/401|authentication required|not authenticated/i.test(message)) return 'auth'
  if (/timed?\s*out|timeout/i.test(message)) return 'timeout'
  return 'failed'
}
