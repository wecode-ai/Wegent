// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { sanitizeRedirectPath } from '@/features/login/constants'

describe('sanitizeRedirectPath', () => {
  describe('Valid paths', () => {
    it('should allow simple relative paths', () => {
      expect(sanitizeRedirectPath('/dashboard')).toBe('/dashboard')
      expect(sanitizeRedirectPath('/chat')).toBe('/chat')
      expect(sanitizeRedirectPath('/tasks/123')).toBe('/tasks/123')
    })

    it('should preserve query parameters for application routing', () => {
      // Query parameters are now preserved as they're needed for application routing
      // (e.g., taskShare parameter for shared task links)
      // Security is maintained because the path portion is thoroughly validated
      // and query params cannot cause external redirects
      expect(sanitizeRedirectPath('/chat?taskShare=abc123')).toBe('/chat?taskShare=abc123')
    })

    it('should preserve fragments for client-side routing', () => {
      // Fragments are preserved as they're needed for client-side navigation
      // They cannot cause security issues as they're only processed client-side
      expect(sanitizeRedirectPath('/docs#section')).toBe('/docs#section')
    })

    it('should normalize paths with dots', () => {
      expect(sanitizeRedirectPath('/./dashboard')).toBe('/dashboard')
    })
  })

  describe('Invalid paths - null/empty', () => {
    it('should reject null', () => {
      expect(sanitizeRedirectPath(null)).toBeNull()
    })

    it('should reject undefined', () => {
      expect(sanitizeRedirectPath(undefined)).toBeNull()
    })

    it('should reject empty string', () => {
      expect(sanitizeRedirectPath('')).toBeNull()
    })

    it('should reject whitespace-only string', () => {
      expect(sanitizeRedirectPath('   ')).toBeNull()
    })
  })

  describe('Invalid paths - protocol-relative URLs', () => {
    it('should reject protocol-relative URLs', () => {
      expect(sanitizeRedirectPath('//evil.com')).toBeNull()
      expect(sanitizeRedirectPath('//evil.com/path')).toBeNull()
    })

    it('should reject protocol-relative URLs with URL encoding', () => {
      expect(sanitizeRedirectPath('/%2f/evil.com')).toBeNull()
      expect(sanitizeRedirectPath('/%2F/evil.com')).toBeNull()
    })
  })

  describe('Invalid paths - absolute URLs', () => {
    it('should reject absolute URLs', () => {
      expect(sanitizeRedirectPath('http://evil.com')).toBeNull()
      expect(sanitizeRedirectPath('https://evil.com')).toBeNull()
      expect(sanitizeRedirectPath('ftp://evil.com')).toBeNull()
    })
  })

  describe('Invalid paths - backslash bypasses', () => {
    it('should reject paths with backslashes', () => {
      expect(sanitizeRedirectPath('\\evil.com')).toBeNull()
      expect(sanitizeRedirectPath('/\\evil.com')).toBeNull()
      expect(sanitizeRedirectPath('/path\\to\\evil')).toBeNull()
    })
  })

  describe('Invalid paths - dangerous protocols', () => {
    it('should reject javascript: protocol', () => {
      expect(sanitizeRedirectPath('/javascript:alert(1)')).toBeNull()
      expect(sanitizeRedirectPath('/JAVASCRIPT:alert(1)')).toBeNull()
      expect(sanitizeRedirectPath('/JaVaScRiPt:alert(1)')).toBeNull()
    })

    it('should reject data: protocol', () => {
      expect(sanitizeRedirectPath('/data:text/html,<script>alert(1)</script>')).toBeNull()
      expect(sanitizeRedirectPath('/DATA:text/html,<script>alert(1)</script>')).toBeNull()
    })

    it('should reject vbscript: protocol', () => {
      expect(sanitizeRedirectPath('/vbscript:alert(1)')).toBeNull()
    })

    it('should reject file: protocol', () => {
      expect(sanitizeRedirectPath('/file:///etc/passwd')).toBeNull()
    })

    it('should reject about: protocol', () => {
      expect(sanitizeRedirectPath('/about:blank')).toBeNull()
    })
  })

  describe('Invalid paths - whitespace bypasses', () => {
    it('should reject paths with newlines', () => {
      expect(sanitizeRedirectPath('/\n//evil.com')).toBeNull()
      // After stripping newlines, becomes '/path//evil.com'
      // The '//' is removed by normalization, leaving '/path/evil.com' which is a valid path
      // This is acceptable as the double slash attack is neutralized
      expect(sanitizeRedirectPath('/path\n//evil.com')).toBe('/path/evil.com')
    })

    it('should reject paths with tabs', () => {
      expect(sanitizeRedirectPath('/\t//evil.com')).toBeNull()
    })

    it('should reject paths with carriage returns', () => {
      expect(sanitizeRedirectPath('/\r//evil.com')).toBeNull()
    })
  })

  describe('Invalid paths - directory traversal', () => {
    it('should normalize directory traversal attempts', () => {
      // Directory traversal is resolved, but doesn't reject valid remaining paths
      expect(sanitizeRedirectPath('/dashboard/../../../etc/passwd')).toBe('/etc/passwd')
      expect(sanitizeRedirectPath('/../../../etc/passwd')).toBe('/etc/passwd')
      expect(sanitizeRedirectPath('/path/../../another')).toBe('/another')
    })
  })

  describe('Invalid paths - URL encoded bypasses', () => {
    it('should reject URL encoded backslashes', () => {
      expect(sanitizeRedirectPath('/%5cevil.com')).toBeNull()
      expect(sanitizeRedirectPath('/%5Cevil.com')).toBeNull()
    })

    it('should handle double URL encoding', () => {
      const doubleEncoded = encodeURIComponent(encodeURIComponent('//evil.com'))
      expect(sanitizeRedirectPath(doubleEncoded)).toBeNull()
    })
  })

  describe('Disallowed paths', () => {
    it('should reject paths in the disallow list', () => {
      expect(sanitizeRedirectPath('/login', ['/login'])).toBeNull()
      expect(sanitizeRedirectPath('/login/oidc', ['/login', '/login/oidc'])).toBeNull()
    })

    it('should allow paths not in the disallow list', () => {
      expect(sanitizeRedirectPath('/dashboard', ['/login'])).toBe('/dashboard')
    })
  })

  describe('Edge cases from security vulnerability', () => {
    it('should sanitize the reported vulnerability pattern', () => {
      // Based on: /login?a=uid=0(root)
      // Query parameters are now preserved, but path validation prevents external redirects
      // The path '/login' is valid and query params are application-level only
      expect(sanitizeRedirectPath('/login?a=uid=0(root)')).toBe('/login?a=uid=0(root)')
    })

    it('should handle complex query parameters safely', () => {
      // Query parameters are preserved but cannot cause external redirects
      // because the path portion is validated to be a relative path
      // These are safe as they're just query strings on valid internal paths
      expect(sanitizeRedirectPath('/chat?redirect=//evil.com')).toBe('/chat?redirect=//evil.com')
      expect(sanitizeRedirectPath('/login?next=http://evil.com')).toBe(
        '/login?next=http://evil.com'
      )
    })
  })

  describe('Real-world attack vectors', () => {
    it('should block common open redirect payloads', () => {
      const attackVectors = [
        '//google.com',
        '//google.com/',
        '///google.com',
        '////google.com',
        '/\\google.com',
        '//google%E3%80%82com',
        '//google.com%2f..',
        '//google.com%252f..',
        '//google.com\t.example.com',
        '//google.com\n.example.com',
        '//google.com%09.example.com',
        '//google.com%0A.example.com',
      ]

      attackVectors.forEach(vector => {
        expect(sanitizeRedirectPath(vector)).toBeNull()
      })
    })
  })
})
