import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { PreferencesStore } from './preferences-store.js'

const timeoutMs = 5_000
const maxPayloadBytes = 1024 * 1024

export class ModelDiagnosticsServer {
  private readonly token = randomBytes(32).toString('base64url')
  private readonly server: Server
  private readonly shutdown = new AbortController()

  constructor(private readonly preferences: PreferencesStore) {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => response.writeHead(400).end())
    })
  }

  async start(): Promise<NodeJS.ProcessEnv> {
    if (!this.server.listening) {
      await new Promise<void>((resolve, reject) => {
        this.server.once('error', reject)
        this.server.listen(0, '127.0.0.1', () => {
          this.server.off('error', reject)
          resolve()
        })
      })
    }
    const address = this.server.address()
    if (!address || typeof address === 'string')
      throw new Error('Missing model diagnostics address')
    return {
      WEWORK_MODEL_DIAGNOSTICS_URL: `http://127.0.0.1:${address.port}/model-http-error`,
      WEWORK_MODEL_DIAGNOSTICS_TOKEN: this.token,
    }
  }

  stop(): void {
    this.shutdown.abort()
    this.server.close()
    this.server.closeAllConnections()
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/model-http-error') {
      response.writeHead(404).end()
      return
    }
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      response.writeHead(401).end()
      return
    }
    const consent = await this.preferences.readDiagnosticsConsent()
    const target = captureDestination(consent?.destination)
    if (!consent || !target) {
      response.writeHead(204).end()
      return
    }
    const signal = AbortSignal.any([
      consent.signal,
      this.shutdown.signal,
      AbortSignal.timeout(timeoutMs),
    ])
    try {
      const properties = await readProperties(request, signal)
      signal.throwIfAborted()
      await fetch(target.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: target.key,
          event: 'model_http_error',
          properties: {
            ...properties,
            distinct_id: 'wework-model-http-diagnostics',
            $process_person_profile: false,
            $geoip_disable: true,
          },
        }),
        redirect: 'error',
        signal,
      }).then(result => result.body?.cancel())
    } catch {
      // Diagnostics delivery does not affect the model request.
    }
    response.writeHead(204).end()
  }
}

function captureDestination(value: unknown) {
  if (!value || typeof value !== 'object' || !('host' in value) || !('projectKey' in value)) return
  if (typeof value.host !== 'string' || typeof value.projectKey !== 'string' || !value.projectKey)
    return
  const url = URL.parse(value.host)
  if (!url || url.username || url.password) return
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/capture/`
  url.search = ''
  url.hash = ''
  return { url, key: value.projectKey }
}

async function readProperties(request: IncomingMessage, signal: AbortSignal) {
  const buffers: Buffer[] = []
  let size = 0
  const cancel = () => request.destroy()
  signal.throwIfAborted()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > maxPayloadBytes) throw new Error('Diagnostic payload is too large')
      buffers.push(bytes)
    }
  } finally {
    signal.removeEventListener('abort', cancel)
  }
  const { http_status, response_body, response_body_encoding, $ai_model } = JSON.parse(
    Buffer.concat(buffers, size).toString('utf8')
  )
  if (
    !Number.isInteger(http_status) ||
    http_status < 400 ||
    http_status >= 600 ||
    typeof response_body !== 'string' ||
    !['utf-8', 'base64'].includes(response_body_encoding) ||
    ($ai_model !== null && typeof $ai_model !== 'string')
  ) {
    throw new Error('Invalid diagnostic payload')
  }
  return { http_status, response_body, response_body_encoding, $ai_model }
}
