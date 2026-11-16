interface RuntimeRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

/** Send verification requests using only the target Runtime's authority-bound cookie. */
export async function requestE2ERuntime(
  environment: NodeJS.ProcessEnv,
  input: RuntimeRequest,
  authenticationCookies: (url: string) => Promise<Array<{ name: string; value: string }>>,
  request: typeof fetch = fetch
) {
  if (environment.VITE_WEWORK_E2E !== 'true' || !environment.WEWORK_E2E_CONTROL_URL) {
    throw new Error('An isolated E2E controller is required')
  }
  const url = new URL(input.url)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    !(url.pathname.startsWith('/wework/') || url.pathname.startsWith('/api/')) ||
    !['GET', 'HEAD', 'POST'].includes(input.method ?? 'GET')
  )
    throw new Error('Expected a local Wework Runtime request')
  const cookies = await authenticationCookies(url.origin)
  if (!cookies.length) throw new Error('Runtime browser authentication is unavailable')
  const headers = new Headers(input.headers)
  headers.set('cookie', cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '))
  const response = await request(url.href, {
    method: input.method ?? 'GET',
    headers,
    body: input.body,
    redirect: 'error',
    signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
  })
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  }
}
