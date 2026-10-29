import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 20

type ProbeResult = Pick<Response, 'ok' | 'status'>

export async function probeHttpReadiness(
  input: string,
  init: Pick<RequestInit, 'signal'> = {}
): Promise<ProbeResult> {
  const signal = init.signal ?? undefined
  signal?.throwIfAborted()
  return requestStatus(probeUrl(input), signal, 0)
}

function probeUrl(input: string, base?: URL): URL {
  let url: URL
  try {
    url = new URL(input, base)
  } catch {
    throw new TypeError('Invalid HTTP readiness URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('HTTP readiness requires an HTTP or HTTPS URL')
  }
  if (url.username || url.password) {
    throw new TypeError('HTTP readiness does not accept embedded credentials')
  }
  return url
}

function requestStatus(
  url: URL,
  signal: AbortSignal | undefined,
  redirects: number
): Promise<ProbeResult> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => reject(signal?.aborted ? signal.reason : error)
    const get = url.protocol === 'https:' ? httpsGet : httpGet
    const request = get(url, { signal, agent: false }, response => {
      response.once('error', fail)
      // Readiness uses only headers. Dispose this one-shot response instead of
      // retaining a body or pooled connection after success or a redirect.
      response.resume()
      response.destroy()
      const status = response.statusCode ?? 0
      const location = response.headers.location
      if (REDIRECT_STATUSES.has(status) && location !== undefined) {
        if (redirects >= MAX_REDIRECTS) {
          reject(new TypeError('HTTP readiness exceeded 20 redirects'))
          return
        }
        try {
          resolve(requestStatus(probeUrl(location, url), signal, redirects + 1))
        } catch (error) {
          reject(error)
        }
      } else {
        resolve({ ok: status >= 200 && status < 300, status })
      }
    })
    request.once('error', fail)
  })
}
