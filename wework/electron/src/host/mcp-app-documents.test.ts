import { describe, expect, it, vi } from 'vitest'
import { McpAppDocuments, mcpAppContentSecurityPolicy } from './mcp-app-documents.js'

describe('MCP App isolated documents', () => {
  it('keeps documents until explicit release without timer renewal', async () => {
    vi.useFakeTimers()
    const documents = new McpAppDocuments()
    try {
      const active = await documents.create('<p>Active</p>', {})
      vi.advanceTimersByTime(24 * 60 * 60 * 1000)
      expect(documents.owns(active.url)).toBe(true)
      documents.release(active.id)
      expect(documents.owns(active.url)).toBe(false)
    } finally {
      documents.dispose()
      vi.useRealTimers()
    }
  })
  it('isolates each origin, enforces CSP in response headers, and releases documents', async () => {
    const documents = new McpAppDocuments()
    try {
      const first = await documents.create('<h1>Private app</h1>', {})
      const second = await documents.create('<h1>Other app</h1>', {})
      expect(new URL(first.url).host).not.toBe(new URL(second.url).host)
      expect(first.url).toMatch(
        /^codex-sandbox:\/\/[a-f0-9-]+\.web-sandbox\.oaiusercontent\.com\/mcp-app\.html$/
      )
      for (const url of [
        first.url + '?other=1',
        first.url.replace('codex-sandbox:', 'https:'),
        first.url.replace('/mcp-app.html', '/unknown'),
        first.url.replace('.web-sandbox.', '.other.'),
      ]) {
        expect(documents.respond(new Request(url)).status).toBe(404)
      }
      expect(documents.respond(new Request(first.url, { method: 'POST' })).status).toBe(404)
      const response = documents.respond(new Request(first.url))
      expect(await response.text()).toBe('<h1>Private app</h1>')
      expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'")
      expect(response.headers.get('content-security-policy')).toContain("frame-src 'none'")
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(documents.respond(new Request(new URL('/unknown', first.url))).status).toBe(404)
      documents.release(first.id)
      expect(documents.respond(new Request(first.url)).status).toBe(404)
      expect(documents.respond(new Request(second.url)).ok).toBe(true)
    } finally {
      documents.dispose()
    }
  })

  it('rejects CSP injection and insecure remote origins while preserving explicit local apps', () => {
    const csp = mcpAppContentSecurityPolicy({
      ui: {
        csp: {
          connectDomains: [
            'https://api.example.com',
            'https://evil.example; default-src *',
            'http://remote.example',
            'http://127.0.0.1:8080',
            'https://safe.example\u0000',
          ],
          resourceDomains: ['https://*.cdn.example.com', "'unsafe-eval'"],
          frameDomains: ['https://ide.example.com'],
        },
      },
    })
    expect(csp).toContain('connect-src https://api.example.com http://127.0.0.1:8080')
    expect(csp).toContain('frame-src https://ide.example.com')
    expect(csp).toContain('https://*.cdn.example.com')
    expect(csp).not.toContain('evil.example')
    expect(csp).not.toContain('remote.example')
    expect(csp).not.toContain('safe.example')
    expect(csp).toContain("form-action 'none'")
  })

  it('serves valid HTTP headers for international domains and rejects control characters', async () => {
    const documents = new McpAppDocuments()
    try {
      const document = await documents.create('<p>App</p>', {
        ui: { csp: { connectDomains: ['https://例子.测试', 'https://safe.example\u0000'] } },
      })
      const response = documents.respond(new Request(document.url))
      expect(response.ok).toBe(true)
      expect(response.headers.get('content-security-policy')).toContain(
        'connect-src https://xn--fsqu00a.xn--0zwm56d'
      )
      expect(response.headers.get('content-security-policy')).not.toContain('safe.example')
    } finally {
      documents.dispose()
    }
  })
})
