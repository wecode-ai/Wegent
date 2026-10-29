// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { NextResponse } from 'next/server'

const HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Opening Wework issue</title>
  </head>
  <body>
    <p id="status">正在建立 Wework Web 登录态...</p>
    <script>
      (function () {
        var status = document.getElementById('status')
        var params = new URLSearchParams(window.location.hash.slice(1))
        var token = params.get('token')
        var redirect = params.get('redirect') || ''
        if (!token || !redirect.startsWith('/collaboration/')) {
          status.textContent = '链接无效，请返回 Wework 重新打开。'
          return
        }
        try {
          var expiry = null
          try {
            var encoded = token.split('.')[1]
            var normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
            var padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
            var payload = JSON.parse(atob(padded))
            if (typeof payload.exp === 'number') expiry = payload.exp * 1000
          } catch (error) {}
          window.localStorage.setItem('auth_token', token)
          if (expiry === null) window.localStorage.removeItem('auth_token_expire')
          else window.localStorage.setItem('auth_token_expire', String(expiry))
          var cookie = 'auth_token=' + encodeURIComponent(token) + '; path=/; SameSite=Lax'
          if (expiry !== null) cookie += '; expires=' + new Date(expiry).toUTCString()
          document.cookie = cookie
          window.history.replaceState(null, '', '/mobile-web-session')
          window.location.replace(redirect)
        } catch (error) {
          status.textContent = '无法保存登录态，请返回 Wework 后重试。'
        }
      })()
    </script>
  </body>
</html>`

export function GET() {
  return new NextResponse(HTML, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
      'X-Frame-Options': 'DENY',
    },
  })
}
