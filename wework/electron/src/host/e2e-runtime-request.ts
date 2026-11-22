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

export interface RuntimeControlInput {
  command: { id: string; action: 'fetchLocalRuntime'; value: string }
  clientId: string
}

export interface RuntimeControlReceipt {
  id: string
  clientId: string
}

type AuthenticationCookies = (url: string) => Promise<Array<{ name: string; value: string }>>

const RUNTIME_CONTROL_REPORT_TIMEOUT_MS = 10_000
const runtimeControlRequests = new Map<string, Promise<RuntimeControlReceipt>>()

function runtimeControlInput(input: unknown): RuntimeControlInput {
  const candidate = input as Partial<RuntimeControlInput> | null
  if (
    !candidate ||
    typeof candidate.clientId !== 'string' ||
    !candidate.clientId ||
    typeof candidate.command?.id !== 'string' ||
    !candidate.command.id ||
    candidate.command.action !== 'fetchLocalRuntime' ||
    typeof candidate.command.value !== 'string'
  )
    throw new Error('Expected an authenticated Runtime control command')
  return {
    command: {
      id: candidate.command.id,
      action: 'fetchLocalRuntime',
      value: candidate.command.value,
    },
    clientId: candidate.clientId,
  }
}

async function reportRuntimeControl(
  environment: NodeJS.ProcessEnv,
  stage: 'started' | 'results',
  body: Record<string, unknown>,
  request: typeof fetch
): Promise<void> {
  const token = environment.WEWORK_E2E_CONTROL_TOKEN?.trim()
  let responseStatus: number | null = null
  try {
    const response = await request(
      `${environment.WEWORK_E2E_CONTROL_URL!.replace(/\/+$/, '')}/${stage}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(RUNTIME_CONTROL_REPORT_TIMEOUT_MS),
      }
    )
    responseStatus = response.status
    await response.arrayBuffer()
    if (!response.ok) throw new Error(`Desktop E2E control ${stage} failed with ${response.status}`)
  } catch (error) {
    console.warn('[desktop-e2e-runtime-control]', {
      commandId: body.id,
      clientId: body.clientId,
      stage,
      responseStatus,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    })
    throw error
  }
}

async function runRuntimeControl(
  environment: NodeJS.ProcessEnv,
  { command, clientId }: RuntimeControlInput,
  authenticationCookies: AuthenticationCookies,
  request: typeof fetch
) {
  const identity = { id: command.id, clientId }
  let actionSucceeded: boolean | undefined
  const startedAt = performance.now()
  const stages: Array<{ stage: string; elapsedMs: number }> = []
  const mark = (stage: string) =>
    stages.push({ stage, elapsedMs: Math.round(performance.now() - startedAt) })
  try {
    // Admission must succeed before reading cookies or making any Runtime request.
    await reportRuntimeControl(
      environment,
      'started',
      { ...identity, action: command.action, value: command.value },
      request
    )
    mark('admitted')
    let result: { ok: boolean; value?: string; error?: string }
    try {
      const response = await requestE2ERuntime(
        environment,
        JSON.parse(command.value),
        authenticationCookies,
        request
      )
      result = { ok: true, value: JSON.stringify(response) }
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    actionSucceeded = result.ok
    mark('runtime-completed')
    await reportRuntimeControl(environment, 'results', { ...identity, ...result }, request)
    mark('result-acknowledged')
    return identity
  } finally {
    console.info('[desktop-e2e-runtime-control]', { ...identity, actionSucceeded, stages })
  }
}

/** Complete the admitted Runtime command without a Renderer continuation. */
export function completeE2ERuntimeControl(
  environment: NodeJS.ProcessEnv,
  input: unknown,
  authenticationCookies: AuthenticationCookies,
  request: typeof fetch = fetch
): Promise<RuntimeControlReceipt> {
  if (environment.VITE_WEWORK_E2E !== 'true' || !environment.WEWORK_E2E_CONTROL_URL) {
    throw new Error('An isolated E2E controller is required')
  }
  const controller = new URL(environment.WEWORK_E2E_CONTROL_URL)
  if (
    controller.protocol !== 'http:' ||
    controller.hostname !== '127.0.0.1' ||
    controller.username ||
    controller.password
  ) {
    throw new Error('Expected a local desktop control endpoint')
  }
  const command = runtimeControlInput(input)
  const key = JSON.stringify([controller.href, command.command.id, command.clientId])
  const existing = runtimeControlRequests.get(key)
  if (existing) return existing
  // Register before the first await: the next Renderer poll may redeliver a
  // command while Native is still waiting for its admission response.
  const completion = Promise.resolve()
    .then(() => runRuntimeControl(environment, command, authenticationCookies, request))
    .finally(() => {
      runtimeControlRequests.delete(key)
    })
  runtimeControlRequests.set(key, completion)
  return completion
}
