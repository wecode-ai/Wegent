import { describe, expect, it, vi } from 'vitest'
import { McpAppDocuments, mcpAppContentSecurityPolicy } from './mcp-app-documents.js'

describe('MCP App isolated documents', () => {
  it('expires abandoned documents and renews live renderer leases', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const documents = new McpAppDocuments()
    try {
      const active = await documents.create('<p>Active</p>', {})
      const abandoned = await documents.create('<p>Abandoned</p>', {})
      vi.advanceTimersByTime(60000)
      documents.renew(active.id)
      vi.advanceTimersByTime(30001)
      expect(documents.owns(abandoned.url)).toBe(false)
      expect(documents.owns(active.url)).toBe(true)
      vi.advanceTimersByTime(60000)
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
      expect(new URL(first.url).origin).not.toBe(new URL(second.url).origin)
      const response = await fetch(first.url)
      expect(await response.text()).toBe('<h1>Private app</h1>')
      expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'")
      expect(response.headers.get('content-security-policy')).toContain("frame-src 'none'")
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect((await fetch(new URL('/unknown', first.url))).status).toBe(404)
      documents.release(first.id)
      await expect(fetch(first.url)).rejects.toThrow()
      expect((await fetch(second.url)).ok).toBe(true)
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
    expect(csp).toContain("form-action 'none'")
  })
})
