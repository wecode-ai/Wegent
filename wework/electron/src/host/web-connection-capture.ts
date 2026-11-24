import { acquireDebuggerSession } from './debugger-session.js'
import type { WebContents } from 'electron'
import { setTimeout as sleep } from 'node:timers/promises'
import { recordedCsrfBinding, type ConnectionCsrfBinding } from './connection-http.js'

export const WEB_CONNECTION_CAPTURE_DURATION_MS = 90_000
const MAX_REQUESTS = 40
const MAX_RESPONSE_BYTES = 64 * 1024
const privateKey = /authorization|token|secret|password|cookie|api.?key/i

type Shape = string | Shape[] | { [key: string]: Shape }

function shape(value: unknown, budget = { remaining: 100 }, depth = 0): Shape {
  if (--budget.remaining < 0 || depth > 7) return '…'
  if (Array.isArray(value)) return value.slice(0, 24).map(item => shape(item, budget, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 32)
        .filter(([key]) => key.length <= 80 && !privateKey.test(key))
        .map(([key, item]) => [key, structuralValue(key, item) ?? shape(item, budget, depth + 1)])
    )
  }
  return value === null ? 'null' : typeof value
}

function structuralValue(key: string, value: unknown): Shape | undefined {
  const identifier = (part: unknown): part is string =>
    typeof part === 'string' && /^[a-zA-Z_$][\w.$-]{0,63}$/.test(part)
  if (['kind', 'operator'].includes(key) && identifier(value)) return value
  if (key === 'columns' && Array.isArray(value) && value.length <= 24 && value.every(identifier))
    return value
  return undefined
}

interface NetworkMessage {
  requestId?: string
  type?: string
  redirectResponse?: unknown
  request?: {
    url?: string
    method?: 'GET' | 'POST'
    postData?: string
    headers?: Record<string, unknown>
  }
  response?: { status: number; mimeType: string }
  encodedDataLength?: number
}

interface RequestSample {
  method: 'GET' | 'POST'
  path: string
  query: string[]
  body?: Shape
  response?: Shape
  accountPaths?: Array<Array<string>>
}

interface CapturedRequest {
  sample: RequestSample
  eligible: boolean
  identity?: Map<string, string | number>
  csrf?: ConnectionCsrfBinding
  finish?: () => void
}

function accountCandidates(value: unknown): Map<string, string | number> {
  const result = new Map<string, string | number>()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  const record = value as Record<string, unknown>
  for (const envelope of ['', 'user', 'account', 'currentUser', 'data']) {
    const object = envelope === '' ? record : record[envelope]
    if (!object || typeof object !== 'object' || Array.isArray(object)) continue
    for (const key of ['id', 'account_id', 'user_id', 'accountId', 'userId']) {
      const id = (object as Record<string, unknown>)[key]
      if (
        (typeof id === 'number' && Number.isSafeInteger(id)) ||
        (typeof id === 'string' && /^[\w@.+-]{1,160}$/.test(id))
      ) {
        result.set(JSON.stringify(envelope ? [envelope, key] : [key]), id)
      }
    }
  }
  return result
}

export async function beginWebConnectionCapture(contents: WebContents, origin: string) {
  const lease = acquireDebuggerSession(contents)
  const requests = new Map<string, CapturedRequest>()
  const pending = new Set<Promise<void>>()
  const counts = { requests: 0, sameSite: 0, json: 0, completed: 0, oversized: 0, bodyErrors: 0 }
  let closed = false
  const message = (_event: unknown, method: string, params: NetworkMessage) => {
    const id = params.requestId
    if (typeof id !== 'string') return
    if (method === 'Network.requestWillBeSent') {
      counts.requests += 1
      if (params.redirectResponse) {
        requests.get(id)?.finish?.()
        requests.delete(id)
      }
      const request = params.request
      const url = typeof request?.url === 'string' ? URL.parse(request.url) : null
      if (url?.origin === origin) counts.sameSite += 1
      if (
        !url ||
        url.origin !== origin ||
        (params.type !== 'XHR' && params.type !== 'Fetch') ||
        (request?.method !== 'GET' && request?.method !== 'POST') ||
        requests.size >= MAX_REQUESTS
      )
        return
      let body: Shape | undefined
      if (typeof request.postData === 'string' && request.postData.length <= MAX_RESPONSE_BYTES) {
        try {
          body = shape(JSON.parse(request.postData))
        } catch {
          /* Ignore non-JSON request bodies. */
        }
      }
      if (request.method === 'POST' && body === undefined) return
      const item: CapturedRequest = {
        sample: {
          method: request.method,
          path: url.pathname,
          query: [...new Set(url.searchParams.keys())]
            .filter(key => key.length <= 80 && !privateKey.test(key))
            .slice(0, 32),
          ...(body === undefined ? {} : { body }),
        },
        eligible: false,
      }
      requests.set(id, item)
      if (request.method === 'POST' && request.headers) {
        const lookup = recordedCsrfBinding(request.headers, url.href, target =>
          contents.session.cookies.get({ url: target })
        )
          .then(binding => {
            item.csrf = binding
          })
          .catch(() => undefined)
        pending.add(lookup)
        void lookup.then(() => pending.delete(lookup))
      }
      return
    }
    const item = requests.get(id)
    if (!item) return
    if (method === 'Network.responseReceived') {
      const response = params.response
      item.eligible = Boolean(
        response &&
        response.status >= 200 &&
        response.status < 300 &&
        /(?:\/|\+)json$/i.test(response.mimeType)
      )
      if (item.eligible) {
        counts.json += 1
        const body = new Promise<void>(resolve => {
          item.finish = resolve
        })
        pending.add(body)
        void body.then(() => pending.delete(body))
      }
    } else if (method === 'Network.loadingFailed') {
      item.finish?.()
      requests.delete(id)
    } else if (method === 'Network.loadingFinished' && item.eligible) {
      counts.completed += 1
      if ((params.encodedDataLength ?? 0) > MAX_RESPONSE_BYTES) {
        counts.oversized += 1
        item.finish?.()
        return
      }
      void lease.session
        .sendCommand('Network.getResponseBody', { requestId: id })
        .then(result => {
          if (
            result.base64Encoded ||
            typeof result.body !== 'string' ||
            result.body.length > MAX_RESPONSE_BYTES
          )
            return
          const parsed: unknown = JSON.parse(result.body)
          item.sample.response = shape(parsed)
          item.identity = accountCandidates(parsed)
          item.sample.accountPaths = [...item.identity.keys()].map(key => JSON.parse(key))
        })
        .catch(() => {
          counts.bodyErrors += 1
        })
        .finally(() => item.finish?.())
    }
  }
  const timer = setTimeout(() => close(), WEB_CONNECTION_CAPTURE_DURATION_MS)
  timer.unref()
  function close() {
    if (closed) return
    closed = true
    clearTimeout(timer)
    if (!contents.isDestroyed()) {
      contents.off('destroyed', close)
      contents.debugger.off('message', message)
      lease.release()
    }
  }
  contents.once('destroyed', close)
  contents.debugger.on('message', message)
  try {
    await lease.session.sendCommand('Network.enable', {
      maxResourceBufferSize: MAX_RESPONSE_BYTES,
      maxTotalBufferSize: MAX_RESPONSE_BYTES * MAX_REQUESTS,
      maxPostDataSize: MAX_RESPONSE_BYTES,
    })
  } catch (error) {
    close()
    throw error
  }
  return {
    close,
    async collect() {
      if (pending.size) {
        await Promise.race([Promise.all(pending), sleep(2000, undefined, { ref: false })])
      }
      close()
      const samples = [...requests.values()].filter(
        request => request.sample.response !== undefined
      )
      if (!samples.length) console.info('[web-connection-capture] No usable requests', counts)
      return samples
    },
  }
}
