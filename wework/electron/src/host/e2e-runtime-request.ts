import { performance } from 'node:perf_hooks'

interface RuntimeRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

function observeRequest(path: string) {
  const startedAt = performance.now()
  const initialCpu = process.cpuUsage()
  const initialEventLoop = performance.eventLoopUtilization()
  const stages: Array<{ stage: string; elapsedMs: number }> = []
  let lastTick = startedAt
  let eventLoopDelayMs = 0
  const timer = setInterval(() => {
    const now = performance.now()
    eventLoopDelayMs = Math.max(eventLoopDelayMs, now - lastTick - 100)
    lastTick = now
  }, 100)
  timer.unref()
  return {
    mark(stage: string) {
      stages.push({ stage, elapsedMs: Math.round(performance.now() - startedAt) })
    },
    finish(failed: boolean) {
      clearInterval(timer)
      const elapsedMs = Math.round(performance.now() - startedAt)
      if (elapsedMs < 1_000 && !(failed && stages.some(entry => entry.stage === 'request'))) return
      console.warn('[desktop-e2e-runtime-request]', {
        path,
        failed,
        elapsedMs,
        eventLoopDelayMs: Math.round(
          Math.max(eventLoopDelayMs, performance.now() - lastTick - 100, 0)
        ),
        cpuTimeMs: Math.round(
          Object.values(process.cpuUsage(initialCpu)).reduce((sum, value) => sum + value, 0) / 1_000
        ),
        eventLoopUtilization: performance.eventLoopUtilization(initialEventLoop).utilization,
        stages,
      })
    },
  }
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
  const observation = observeRequest(url.pathname)
  let failed = true
  try {
    observation.mark('authentication')
    const cookies = await authenticationCookies(url.origin)
    if (!cookies.length) throw new Error('Runtime browser authentication is unavailable')
    const headers = new Headers(input.headers)
    headers.set('cookie', cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '))
    observation.mark('request')
    const response = await request(url.href, {
      method: input.method ?? 'GET',
      headers,
      body: input.body,
      redirect: 'error',
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
    })
    observation.mark('response-body')
    const body = await response.text()
    observation.mark('complete')
    failed = false
    return { status: response.status, headers: Object.fromEntries(response.headers), body }
  } finally {
    observation.finish(failed)
  }
}
