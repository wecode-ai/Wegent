#!/usr/bin/env node

import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'

const [distArgument, portArgument] = process.argv.slice(2)
if (!distArgument || !portArgument) {
  throw new Error('Usage: node scripts/serve-dev-frontend.mjs <dist> <port>')
}

const dist = resolve(distArgument)
const port = Number.parseInt(portArgument, 10)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid frontend port: ${portArgument}`)
}

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function optionalEnvironmentValue(key) {
  const value = process.env[key]?.trim()
  return value || undefined
}

function runtimeConfigScript() {
  const config = {
    cloudBackendUrl: optionalEnvironmentValue('WEWORK_E2E_CLOUD_BACKEND_URL'),
    cloudToken: optionalEnvironmentValue('WEWORK_E2E_CLOUD_TOKEN'),
    controlToken: optionalEnvironmentValue('WEWORK_E2E_CONTROL_TOKEN'),
    controlUrl: optionalEnvironmentValue('WEWORK_E2E_CONTROL_URL'),
    modelServerUrl: optionalEnvironmentValue('WEWORK_E2E_MODEL_SERVER_URL'),
    posthogHost: optionalEnvironmentValue('WEWORK_E2E_POSTHOG_HOST'),
  }
  const devInstance = {
    title: optionalEnvironmentValue('WEWORK_DEV_TITLE'),
    port: optionalEnvironmentValue('WEWORK_DEV_PORT'),
    worktree: optionalEnvironmentValue('WEWORK_DEV_WORKTREE'),
    branch: optionalEnvironmentValue('WEWORK_DEV_BRANCH'),
    parentTitle: optionalEnvironmentValue('WEWORK_PARENT_TITLE'),
    parentProject: optionalEnvironmentValue('WEWORK_PARENT_PROJECT'),
    parentWorkspace: optionalEnvironmentValue('WEWORK_PARENT_WORKSPACE'),
  }
  const serialized = JSON.stringify(config)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
  const serializedDevInstance = JSON.stringify(devInstance)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
  return `<script>
window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__=${serialized};
window.__WEWORK_DEV_INSTANCE__=${serializedDevInstance};
(() => {
  const config = window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__
  if (!config.controlUrl || !config.controlToken) return
  const visible = element => {
    if (!element) return false
    let current = element
    while (current) {
      const style = window.getComputedStyle(current)
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        current.getAttribute('aria-hidden') === 'true'
      ) return false
      current = current.parentElement
    }
    const rect = element.getBoundingClientRect()
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    )
  }
  const probe = () => {
    const shell = document.querySelector('[data-testid="app-shell"]')
    const content = document.querySelector('[data-testid="desktop-workbench-content"]')
    const loading = document.querySelector('[data-testid="desktop-workbench-loading"]')
    const startup = document.querySelector('[data-testid="local-runtime-initializer"]')
    const startupError = document.querySelector('[data-testid="workbench-startup-error"]')
    fetch(config.controlUrl + '/probe', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.controlToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        location: window.location.href,
        windowLabel: window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null,
        readyState: document.readyState,
        tauriInternals: '__TAURI_INTERNALS__' in window,
        tauriGlobal: '__TAURI__' in window,
        shell: Boolean(shell),
        shellVisible: visible(shell),
        content: Boolean(content),
        contentVisible: visible(content),
        loading: Boolean(loading),
        loadingVisible: visible(loading),
        startup: Boolean(startup),
        startupVisible: visible(startup),
        startupError: Boolean(startupError),
        bodyText: document.body?.innerText?.slice(0, 240) ?? '',
      }),
    }).catch(() => undefined)
  }
  probe()
  window.addEventListener('DOMContentLoaded', probe, { once: true })
  window.setInterval(probe, 500)
})()
</script>`
}

async function serveIndex(response, headOnly) {
  const index = await readFile(resolve(dist, 'index.html'), 'utf8')
  const body = index.replace('<head>', `<head>${runtimeConfigScript()}`)
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': mimeTypes['.html'],
  })
  response.end(headOnly ? undefined : body)
}

async function regularFile(path) {
  try {
    const metadata = await stat(path)
    return metadata.isFile()
  } catch {
    return false
  }
}

const server = createServer(async (request, response) => {
  try {
    const method = request.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' })
      response.end()
      return
    }

    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
    const relative = pathname.replace(/^\/+/, '')
    const candidate = resolve(dist, relative || 'index.html')
    if (candidate !== dist && !candidate.startsWith(`${dist}${sep}`)) {
      response.writeHead(403)
      response.end()
      return
    }

    if (relative === '' || relative === 'index.html' || !(await regularFile(candidate))) {
      await serveIndex(response, method === 'HEAD')
      return
    }

    const metadata = await stat(candidate)
    response.writeHead(200, {
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': metadata.size,
      'Content-Type': mimeTypes[extname(candidate)] ?? 'application/octet-stream',
    })
    if (method === 'HEAD') {
      response.end()
    } else {
      createReadStream(candidate).pipe(response)
    }
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end(error instanceof Error ? error.message : String(error))
  }
})

server.listen(port, '0.0.0.0', () => {
  console.log(`Wework cached frontend listening on http://localhost:${port}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)))
}
