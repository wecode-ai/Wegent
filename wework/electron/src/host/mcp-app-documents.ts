import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'

type Metadata = Record<string, unknown>

function record(value: unknown): Metadata {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Metadata)
    : {}
}

function domains(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => {
    if (typeof item !== 'string' || /[\s;'"<>]/.test(item)) return false
    try {
      const url = new URL(item.replace('://*.', '://wildcard.'))
      return (
        ['https:', 'wss:', 'http:', 'ws:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash &&
        (!['http:', 'ws:'].includes(url.protocol) ||
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      )
    } catch {
      return false
    }
  })
}

export function mcpAppContentSecurityPolicy(metadata: Metadata): string {
  const csp = record(record(metadata.ui).csp ?? metadata['openai/widgetCSP'])
  const connect = domains(csp.connectDomains ?? csp.connect_domains)
  const resources = domains(csp.resourceDomains ?? csp.resource_domains)
  const frames = domains(csp.frameDomains ?? csp.frame_domains)
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${resources.join(' ')}`,
    `style-src 'unsafe-inline' ${resources.join(' ')}`,
    `img-src data: blob: ${resources.join(' ')}`,
    `font-src data: ${resources.join(' ')}`,
    `media-src blob: ${resources.join(' ')}`,
    `connect-src ${connect.length ? connect.join(' ') : "'none'"}`,
    `frame-src ${frames.length ? frames.join(' ') : "'none'"}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

/** Each document has its own origin, never the workbench's cookies or host bridge. */
export class McpAppDocuments {
  private readonly documents = new Map<string, { server: Server; expiry: NodeJS.Timeout }>()

  owns(url: string): boolean {
    try {
      const parsed = new URL(url)
      const server = this.documents.get(parsed.pathname.slice(1))?.server
      const address = server?.address()
      return (
        !!address &&
        typeof address !== 'string' &&
        parsed.origin === `http://127.0.0.1:${address.port}` &&
        !parsed.search &&
        !parsed.hash
      )
    } catch {
      return false
    }
  }

  async create(html: string, metadata: Metadata): Promise<{ id: string; url: string }> {
    if (Buffer.byteLength(html) > 10 * 1024 * 1024) throw new Error('MCP App document is too large')
    if (this.documents.size >= 64) throw new Error('Too many active MCP App documents')
    const id = randomUUID()
    const csp = mcpAppContentSecurityPolicy(metadata)
    const server = createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== `/${id}` || request.headers.host !== host) {
        response.writeHead(404).end()
        return
      }
      response
        .writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': csp,
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
        })
        .end(html)
    })
    let host = ''
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('Invalid MCP App address')
    }
    host = `127.0.0.1:${address.port}`
    server.unref()
    this.documents.set(id, { server, expiry: setTimeout(() => this.release(id), 90000).unref() })
    return { id, url: `http://${host}/${id}` }
  }

  release(id: string): void {
    const document = this.documents.get(id)
    this.documents.delete(id)
    if (!document) return
    clearTimeout(document.expiry)
    document.server.closeAllConnections()
    document.server.close()
  }

  renew(id: string): void {
    const document = this.documents.get(id)
    if (!document) throw new Error('MCP App document has expired')
    document.expiry.refresh()
  }

  dispose(): void {
    for (const id of this.documents.keys()) this.release(id)
  }
}
