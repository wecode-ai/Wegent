// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'

const HTML = String.raw`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Opening Wework issue</title>
  </head>
  <body>
    <p id="status" data-testid="mobile-web-session-status">正在建立 Wework Web 登录态...</p>
    <script>
      (function () {
        var status = document.getElementById('status')
        var params = new URLSearchParams(window.location.search)
        var redirect = params.get('redirect') || ''
        var bridge = window.ReactNativeWebView
        if (window.location.hash || !bridge || !window.crypto || !validRedirect(redirect)) {
          status.textContent = '链接无效，请返回 Wework 重新打开。'
          return
        }

        function validRedirect(value) {
          if (!value.startsWith('/collaboration/') || /[\\\u0000-\u001f\u007f]/.test(value)) return false
          var url = new URL(value, 'https://wework.invalid')
          if (url.origin !== 'https://wework.invalid' || url.hash || !/^\/collaboration\/[1-9]\d*\/issues\/[^/?#]+$/.test(url.pathname)) return false
          var keys = Array.from(url.searchParams.keys())
          return keys.length <= 2 && new Set(keys).size === keys.length && keys.every(function (key) {
            return ['commentId', 'focusRequest'].includes(key) && !!url.searchParams.get(key)
          })
        }

        function existingTokens() {
          var tokens = []
          var stored = window.localStorage.getItem('auth_token')
          if (stored) tokens.push(stored)
          document.cookie.split(';').forEach(function (part) {
            var pair = part.trim()
            if (pair.startsWith('auth_token=')) {
              var value = decodeURIComponent(pair.slice('auth_token='.length))
              if (value && !tokens.includes(value)) tokens.push(value)
            }
          })
          return tokens
        }

        var nonce = Array.from(window.crypto.getRandomValues(new Uint8Array(32)), function (value) {
          return value.toString(16).padStart(2, '0')
        }).join('')
        var claimed = false
        function reportError(code) {
          status.textContent = code === 409
            ? 'Web 中已登录其他账户，请保留当前账户并返回 Wework 处理。'
            : '授权已失效或无法建立登录态，请返回 Wework 后重试。'
          bridge.postMessage(JSON.stringify({ type: 'wework.web-session.error', status: code, nonce: nonce }))
        }

        window.addEventListener('message', async function (event) {
          var grant
          try { grant = JSON.parse(event.data) } catch (error) { return }
          if (!grant || grant.type !== 'wework.web-session.grant' || grant.nonce !== nonce || claimed || typeof grant.code !== 'string') return
          claimed = true
          try {
            var before = existingTokens()
            var response = await fetch('/api/auth/wework/web-sessions/exchange', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ code: grant.code, nonce: nonce, redirect: redirect, existing_tokens: before })
            })
            if (!response.ok) { reportError(response.status); return }
            var session = await response.json()
            if (JSON.stringify(before) !== JSON.stringify(existingTokens())) { reportError(409); return }
            if (typeof session.access_token !== 'string' || typeof session.expires_at !== 'number') { reportError(502); return }
            window.localStorage.setItem('auth_token', session.access_token)
            window.localStorage.setItem('auth_token_expire', String(session.expires_at * 1000))
            var cookie = 'auth_token=' + encodeURIComponent(session.access_token) + '; path=/; SameSite=Lax'
            if (window.location.protocol === 'https:') cookie += '; Secure'
            document.cookie = cookie + '; expires=' + new Date(session.expires_at * 1000).toUTCString()
            window.location.replace(redirect)
          } catch (error) {
            reportError(503)
          }
        })
        try {
          bridge.postMessage(JSON.stringify({ type: 'wework.web-session.request', nonce: nonce, redirect: redirect }))
        } catch (error) {
          reportError(503)
        }
      })()
    </script>
  </body>
</html>`

export function GET() {
  const script = HTML.match(/<script>([\s\S]*?)<\/script>/)![1]
  const hash = createHash('sha256').update(script).digest('base64')
  return new NextResponse(HTML, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${hash}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      'Referrer-Policy': 'no-referrer',
    },
  })
}
