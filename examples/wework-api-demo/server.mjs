import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const port = Number(process.env.DEMO_PORT || 8765)
const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.mjs': ['app.mjs', 'text/javascript; charset=utf-8'],
  '/sse.mjs': ['sse.mjs', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
}

function json(response, status, message) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ error: message }))
}

function allowedRequest(method, pathname) {
  if (method === 'GET') {
    return /^\/(devices|models|conversations|conversations\/[^/]+|responses\/[^/]+)$/.test(
      pathname,
    )
  }
  return method === 'POST' && /^\/responses(?:\/[^/]+\/cancel)?$/.test(pathname)
}

async function proxy(request, response, url) {
  const pathname = url.pathname.slice('/proxy'.length)
  if (!allowedRequest(request.method, pathname)) {
    return json(response, 405, 'Demo 只支持查询、创建和停止接口。')
  }
  let base
  try {
    base = new URL(request.headers['x-demo-base'])
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    ) {
      throw new Error('Invalid URL')
    }
  } catch {
    return json(response, 400, '请输入有效的 HTTP(S) API 地址，不要在地址里放 Key。')
  }
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1_048_576) return json(response, 413, '请求超过 1 MB。')
    chunks.push(chunk)
  }
  const abort = new AbortController()
  const onClose = () => abort.abort()
  response.once('close', onClose)
  // Only bound the wait for response headers; SSE can continue for long tasks.
  const timeout = setTimeout(() => abort.abort(), 60_000)
  try {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    for (const key of ['authorization', 'x-api-key']) {
      if (request.headers[key]) headers[key] = request.headers[key]
    }
    const target = `${base.href.replace(/\/$/, '')}${pathname}${url.search}`
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
      signal: abort.signal,
      redirect: 'error',
    })
    clearTimeout(timeout)
    response.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    })
    response.flushHeaders()
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response)
    else response.end()
  } catch (error) {
    if (!response.destroyed && !response.headersSent) {
      json(
        response,
        502,
        abort.signal.aborted
          ? '等待 backend 响应头超过 60 秒。提交可能已被接受，请先查会话，避免重复创建。'
          : `无法连接 backend：${error.message}。请检查 API 地址、网络和服务状态。`,
      )
    } else if (!response.destroyed) response.destroy()
  } finally {
    clearTimeout(timeout)
    response.removeListener('close', onClose)
  }
}

const server = http.createServer(async (request, response) => {
  // Keep this local credential-forwarding utility inaccessible to other origins.
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`]
  if (
    !hosts.includes(request.headers.host) ||
    (request.headers.origin &&
      request.headers.origin !== `http://${request.headers.host}`)
  ) {
    return json(response, 403, '只允许本地 Demo 页面访问。')
  }
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  )
  try {
    const url = new URL(request.url, `http://${request.headers.host}`)
    if (url.pathname.startsWith('/proxy/')) return await proxy(request, response, url)
    const asset = assets[url.pathname]
    if (request.method !== 'GET' || !asset) return json(response, 404, 'Not found')
    const content = await readFile(new URL(asset[0], import.meta.url))
    response.writeHead(200, { 'Content-Type': asset[1] })
    response.end(content)
  } catch {
    if (!response.headersSent) json(response, 500, 'Demo 服务发生错误。')
    else response.destroy()
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`Wework API Demo: http://127.0.0.1:${port}`)
  console.log(`Directory: ${fileURLToPath(new URL('.', import.meta.url))}`)
})
server.on('error', (error) => {
  console.error(`Demo 无法启动：${error.message}`)
  process.exitCode = 1
})
