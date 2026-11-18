const DEFAULT_MODEL_PATHS = new Map([
  ['/responses', 'responses'],
  ['/v1/responses', 'responses'],
  ['/backend-api/codex/responses', 'responses'],
  ['/chat/completions', 'chat'],
  ['/v1/chat/completions', 'chat'],
  ['/messages', 'anthropic'],
  ['/v1/messages', 'anthropic'],
])

/** Identify evidence endpoints without changing which requests use the default handler. */
export function modelRequestRoute(pathname) {
  const protocol = DEFAULT_MODEL_PATHS.get(pathname)
  if (protocol) return { protocol, defaultHandler: true }
  for (const [suffix, protocol] of DEFAULT_MODEL_PATHS) {
    if (suffix.startsWith('/v1/') && pathname.endsWith(suffix))
      return { protocol, defaultHandler: false }
  }
  if (pathname === '/responses/compact' || pathname.endsWith('/v1/responses/compact'))
    return { protocol: 'responses-compact', defaultHandler: false }
  return null
}
