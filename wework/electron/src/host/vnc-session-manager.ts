import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

interface VncSession {
  wsUrl: string
  token: string
  expiresAt: number
}

export class VncSessionManager {
  private readonly sessions = new Map<string, VncSession>()
  private server: Server | null = null
  private origin: string | null = null

  constructor(
    private readonly assetsDirectory: string,
    private readonly ttlMs = 120_000
  ) {}

  async start(): Promise<void> {
    if (this.server) return
    const server = createServer((request, response) => {
      void this.handle(request.method ?? '', request.url ?? '/', request.headers.host, response)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('VNC external bridge address is unavailable')
    }
    this.server = server
    this.origin = `http://127.0.0.1:${address.port}`
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.origin = null
    this.sessions.clear()
    if (!server) return
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    )
  }

  externalBridgeUrl(): string {
    if (!this.origin) throw new Error('VNC external bridge is unavailable')
    return this.origin
  }

  prepareSession(input: { sessionId: string; wsUrl: string; token: string }): void {
    if (!/^[0-9a-f-]{36}$/i.test(input.sessionId)) throw new Error('Invalid VNC session id')
    const url = new URL(input.wsUrl)
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Invalid VNC WebSocket URL')
    }
    if (!input.token.trim() || Buffer.byteLength(input.token) > 16 * 1024) {
      throw new Error('Invalid VNC bearer token')
    }
    const existing = this.sessions.get(input.sessionId)
    if (existing && (existing.wsUrl !== input.wsUrl || existing.token !== input.token)) {
      throw new Error('VNC session id is already active')
    }
    this.sessions.set(input.sessionId, {
      wsUrl: input.wsUrl,
      token: input.token,
      expiresAt: Date.now() + this.ttlMs,
    })
  }

  private async handle(
    method: string,
    requestUrl: string,
    host: string | undefined,
    response: import('node:http').ServerResponse
  ): Promise<void> {
    const expectedHost = this.origin ? new URL(this.origin).host : ''
    if (method !== 'GET' || host !== expectedHost) {
      this.send(response, 400, 'application/json', JSON.stringify({ error: 'Invalid request' }))
      return
    }
    const pathname = new URL(requestUrl, this.origin ?? 'http://127.0.0.1').pathname
    try {
      if (pathname === '/' || pathname === '/vnc.html') {
        this.send(
          response,
          200,
          'text/html; charset=utf-8',
          await readFile(join(this.assetsDirectory, 'vnc.html'))
        )
        return
      }
      if (pathname === '/novnc/rfb.min.js') {
        this.send(
          response,
          200,
          'application/javascript; charset=utf-8',
          await readFile(join(this.assetsDirectory, 'novnc', 'rfb.min.js'))
        )
        return
      }
      const sessionId = pathname.startsWith('/session/') ? pathname.slice('/session/'.length) : ''
      const session = this.sessions.get(sessionId)
      if (!session || session.expiresAt <= Date.now()) {
        this.sessions.delete(sessionId)
        this.send(
          response,
          404,
          'application/json',
          JSON.stringify({ error: 'VNC session is missing or expired' })
        )
        return
      }
      this.send(
        response,
        200,
        'application/json',
        JSON.stringify({
          wsUrl: session.wsUrl,
          token: session.token,
        })
      )
    } catch (error) {
      this.send(
        response,
        500,
        'application/json',
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        })
      )
    }
  }

  private send(
    response: import('node:http').ServerResponse,
    status: number,
    contentType: string,
    body: string | Buffer
  ): void {
    response.writeHead(status, {
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'",
      'content-type': contentType,
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    })
    response.end(body)
  }
}
