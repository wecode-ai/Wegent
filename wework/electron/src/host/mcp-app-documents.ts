import { randomUUID } from 'node:crypto'

type Metadata = Record<string, unknown>

function record(value: unknown): Metadata {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Metadata)
    : {}
}

function domains(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): string[] => {
    if (typeof item !== 'string' || /[\s;'"<>]/.test(item)) return []
    const hasControl = Array.from(item).some(character => {
      const code = character.charCodeAt(0)
      return code < 0x20 || (code >= 0x7f && code <= 0x9f)
    })
    if (hasControl) return []
    try {
      const wildcard = item.includes('://*.')
      const url = new URL(item.replace('://*.', '://wildcard.'))
      const allowed =
        ['https:', 'wss:', 'http:', 'ws:'].includes(url.protocol) &&
        !url.hostname.includes('*') &&
        !url.username &&
        !url.password &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash &&
        (!['http:', 'ws:'].includes(url.protocol) ||
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      if (!allowed) return []
      return [wildcard ? url.origin.replace('://wildcard.', '://*.') : url.origin]
    } catch {
      return []
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

export const MCP_APP_SCHEME = 'codex-sandbox'
const sandboxDomain = 'web-sandbox.oaiusercontent.com'

/** Each document has its own origin, never the workbench's cookies or host bridge. */
export class McpAppDocuments {
  private readonly documents = new Map<
    string,
    { url: string; html: string; csp: string; expiry: NodeJS.Timeout }
  >()

  owns(url: string): boolean {
    try {
      const parsed = new URL(url)
      const id = parsed.hostname.slice(0, -(sandboxDomain.length + 1))
      return this.documents.get(id)?.url === url
    } catch {
      return false
    }
  }

  respond(request: Request): Response {
    if (request.method !== 'GET' || !this.owns(request.url)) {
      return new Response(null, { status: 404 })
    }
    const id = new URL(request.url).hostname.slice(0, -(sandboxDomain.length + 1))
    const document = this.documents.get(id)!
    return new Response(document.html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': document.csp,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      },
    })
  }

  async create(html: string, metadata: Metadata): Promise<{ id: string; url: string }> {
    if (Buffer.byteLength(html) > 10 * 1024 * 1024) throw new Error('MCP App document is too large')
    if (this.documents.size >= 64) throw new Error('Too many active MCP App documents')
    const id = randomUUID()
    const url = `${MCP_APP_SCHEME}://${id}.${sandboxDomain}/mcp-app.html`
    this.documents.set(id, {
      url,
      html,
      csp: mcpAppContentSecurityPolicy(metadata),
      expiry: setTimeout(() => this.release(id), 90000).unref(),
    })
    return { id, url }
  }

  release(id: string): void {
    const document = this.documents.get(id)
    this.documents.delete(id)
    if (document) clearTimeout(document.expiry)
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
