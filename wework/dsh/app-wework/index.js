import { createReadStream, readFileSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'wework-app'
export const inject = ['webServer']

export const APP_BASE_PATH = '/wework/app'
const API_PROXY_PATH = '/wework/api'
const SOCKET_PROXY_PATH = '/wework/socket.io'
const DEEP_LINK_PARAMETER = '__wework_route'
const HOT_RELOAD_BUILD_ID_FILE = '.wework-build-id'
const configuredWebRoot = process.env.WEWORK_APP_WEB_ROOT?.trim()
const webRoot = configuredWebRoot
  ? resolve(configuredWebRoot)
  : resolve(dirname(fileURLToPath(import.meta.url)), 'web')
const indexPath = join(webRoot, 'index.html')
const hotReloadBuildIdPath = join(webRoot, HOT_RELOAD_BUILD_ID_FILE)

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export function apply(ctx) {
  const backendUrl = resolveBackendUrl(process.env)
  ctx.on('webserver/index-inject', table => {
    table.push(...weworkIndexInjection(process.env, indexPath))
  })
  register(ctx, 'prefix', APP_BASE_PATH, serveWeworkApp)
  if (!backendUrl) return

  register(ctx, 'prefix', API_PROXY_PATH, (req, res) =>
    proxyHttpRequest(req, res, backendUrl, API_PROXY_PATH, '/api')
  )
  register(ctx, 'exact', SOCKET_PROXY_PATH, (req, res) =>
    proxyHttpRequest(req, res, backendUrl, SOCKET_PROXY_PATH, '/socket.io')
  )
  ctx.effect(
    () =>
      ctx.webServer.registerUpgrade({
        path: SOCKET_PROXY_PATH,
        handler: (req, socket, head) => proxyWebSocket(req, socket, head, backendUrl),
      }),
    `wework-app: ${SOCKET_PROXY_PATH} upgrade`
  )
}

function register(ctx, kind, path, handler) {
  ctx.effect(() => ctx.webServer.register({ kind, path, handler }), `wework-app: ${path}`)
}

function singleHeader(value) {
  return Array.isArray(value) ? value[0] : value
}

export async function serveWeworkApp(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  const requestUrl = new URL(req.url ?? APP_BASE_PATH, 'http://localhost')
  const pathname = decodeURIComponent(requestUrl.pathname)
  const relativePath = pathname.slice(APP_BASE_PATH.length).replace(/^\/+/, '')
  if (relativePath === 'runtime-config.js') {
    const body = runtimeConfigScript(
      process.env,
      desktopWindowLabel(req.headers['x-wework-window-label'])
    )
    res.writeHead(200, {
      'content-type': MIME_TYPES['.js'],
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(req.method === 'HEAD' ? undefined : body)
    return
  }
  const target = resolve(normalize(join(webRoot, relativePath)))
  if (target !== webRoot && !target.startsWith(`${webRoot}${sep}`)) {
    res.writeHead(403)
    res.end()
    return
  }

  const asset = relativePath && (await isFile(target)) ? target : indexPath
  if (!(await isFile(asset))) {
    res.writeHead(503, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end('Wework DSH application assets are unavailable')
    return
  }

  if (asset === indexPath) {
    if (req.method === 'HEAD' && process.env.WEWORK_APP_HOT_RELOAD === '1') {
      res.writeHead(200, {
        'cache-control': 'no-store',
        'x-wework-app-build-id': hotReloadBuildId(hotReloadBuildIdPath, indexPath),
      })
      res.end()
      return
    }
    res.writeHead(302, {
      'cache-control': 'no-store',
      location: coreDshDeepLinkLocation(requestUrl),
    })
    res.end()
    return
  }

  const metadata = await stat(asset)
  res.writeHead(200, {
    'content-type': MIME_TYPES[extname(asset)] ?? 'application/octet-stream',
    'cache-control': weworkAssetCacheControl(process.env),
    'content-length': metadata.size,
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(asset).pipe(res)
}

export function coreDshDeepLinkLocation(value) {
  const requestUrl = value instanceof URL ? value : new URL(value, 'http://localhost')
  const location = new URL('/', 'http://localhost')
  location.searchParams.set(
    DEEP_LINK_PARAMETER,
    `${requestUrl.pathname}${requestUrl.search}${requestUrl.hash}`
  )
  return `${location.pathname}${location.search}`
}

export function injectDevelopmentReload(html, environment, buildId) {
  if (environment.WEWORK_APP_HOT_RELOAD !== '1') return html
  const script = `<script>(()=>{const current=${escapeJsonForHtml(
    buildId
  )};let checking=false;setInterval(async()=>{if(checking)return;checking=true;try{const response=await fetch(${JSON.stringify(
    `${APP_BASE_PATH}/`
  )},{method:'HEAD',cache:'no-store'});const next=response.headers.get('x-wework-app-build-id');if(next&&next!==current)window.location.reload()}catch{}finally{checking=false}},500)})()</script>`
  return html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : `${script}${html}`
}

export function weworkIndexInjection(environment = process.env, appIndexPath = indexPath) {
  const assets = weworkIndexAssets(readFileSync(appIndexPath, 'utf8'))
  const developmentReload = injectDevelopmentReload(
    '',
    environment,
    hotReloadBuildId(join(dirname(appIndexPath), HOT_RELOAD_BUILD_ID_FILE), appIndexPath)
  )
  const injection = [
    {
      kind: 'html',
      placement: 'head',
      html: assets.head,
    },
    {
      kind: 'html',
      placement: 'body',
      html: `<script src="${APP_BASE_PATH}/runtime-config.js"></script>`,
    },
  ]
  if (developmentReload) {
    injection.push({
      kind: 'html',
      placement: 'body',
      html: developmentReload,
    })
  }
  return injection
}

function fileBuildId(path) {
  const metadata = statSync(path, { bigint: true })
  return `${metadata.mtimeNs}:${metadata.size}`
}

function hotReloadBuildId(buildIdPath, appIndexPath) {
  try {
    const buildId = readFileSync(buildIdPath, 'utf8').trim()
    if (buildId) return buildId
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return fileBuildId(appIndexPath)
}

export function weworkAssetCacheControl(environment = process.env) {
  return environment.WEWORK_APP_HOT_RELOAD === '1'
    ? 'no-store'
    : 'public, max-age=31536000, immutable'
}

export function injectRuntimeConfig(html, environment = process.env, windowLabel = 'main') {
  const script = `<script>${runtimeConfigScript(environment, windowLabel)}</script>`
  return html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : `${script}${html}`
}

export function runtimeConfigScript(environment = process.env, windowLabel = 'main') {
  const backendUrl = resolveBackendUrl(environment)
  const socketUrl = resolveSocketUrl(environment)
  const runtimeConfig = {
    appBasePath: APP_BASE_PATH,
    desktopHost: 'electron',
    desktopWindowLabel: windowLabel,
    apiBaseUrl: backendUrl ? API_PROXY_PATH : `${APP_BASE_PATH}/api`,
    socketBaseUrl: socketUrl ?? '',
    socketPath: SOCKET_PROXY_PATH,
    wegentBackendUrl: backendUrl ?? '',
    runtimeMode: 'local-first',
  }
  const desktopE2EConfig = compactObject({
    cloudBackendUrl:
      environment.WEWORK_E2E_CLOUD_BACKEND_URL || environment.VITE_WEWORK_E2E_CLOUD_BACKEND_URL,
    cloudToken: environment.WEWORK_E2E_CLOUD_TOKEN || environment.VITE_WEWORK_E2E_CLOUD_TOKEN,
    codexHomeInitialization: environmentBoolean(
      environment,
      'WEWORK_E2E_CODEX_HOME_INITIALIZATION',
      'VITE_WEWORK_E2E_CODEX_HOME_INITIALIZATION'
    ),
    controlToken:
      environment.WEWORK_E2E_CONTROL_TOKEN || environment.VITE_WEWORK_DESKTOP_E2E_CONTROL_TOKEN,
    controlUrl:
      environment.WEWORK_E2E_CONTROL_URL || environment.VITE_WEWORK_DESKTOP_E2E_CONTROL_URL,
    localModelsCatalogReady: environmentBoolean(
      environment,
      'WEWORK_E2E_LOCAL_MODELS_CATALOG_READY',
      'VITE_WEWORK_E2E_LOCAL_MODELS_CATALOG_READY'
    ),
    modelServerUrl:
      environment.WEWORK_E2E_MODEL_SERVER_URL || environment.VITE_WEWORK_E2E_MODEL_SERVER_URL,
    posthogHost: environment.WEWORK_E2E_POSTHOG_HOST || environment.VITE_WEWORK_POSTHOG_HOST,
    posthogKey: environment.WEWORK_E2E_POSTHOG_KEY || environment.VITE_WEWORK_POSTHOG_KEY,
    seedLocalModels: environmentBoolean(
      environment,
      'WEWORK_E2E_SEED_LOCAL_MODELS',
      'VITE_WEWORK_E2E_SEED_LOCAL_MODELS'
    ),
    transcriptPageSize: environmentPositiveInteger(
      environment,
      'WEWORK_E2E_TRANSCRIPT_PAGE_SIZE',
      'VITE_WEWORK_E2E_TRANSCRIPT_PAGE_SIZE'
    ),
    worktreeCreationDelayMs: environmentPositiveInteger(
      environment,
      'WEWORK_E2E_WORKTREE_CREATION_DELAY_MS',
      'VITE_WEWORK_E2E_WORKTREE_CREATION_DELAY_MS'
    ),
  })
  return `${restoreDeepLinkScript()}window.__WEWORK_RUNTIME_CONFIG__=${escapeJsonForHtml(
    runtimeConfig
  )};window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__=${escapeJsonForHtml(desktopE2EConfig)}`
}

function restoreDeepLinkScript() {
  return `(()=>{const value=new URLSearchParams(window.location.search).get(${JSON.stringify(
    DEEP_LINK_PARAMETER
  )});if(!value)return;try{const target=new URL(value,window.location.origin);const base=${JSON.stringify(
    APP_BASE_PATH
  )};if(target.origin===window.location.origin&&(target.pathname===base||target.pathname.startsWith(base+'/'))){window.history.replaceState(window.history.state,'',target.pathname+target.search+target.hash)}}catch{}})();`
}

export function weworkIndexAssets(html) {
  const head = html.match(/<head(?:\s[^>]*)?>([\s\S]*?)<\/head>/i)?.[1] ?? ''
  const tags =
    head.match(
      /<(?:script)\b[^>]*type=["']module["'][^>]*><\/script>|<link\b[^>]*rel=["'](?:modulepreload|stylesheet)["'][^>]*>/gi
    ) ?? []
  if (tags.length === 0) {
    throw new Error('Wework application index contains no module or stylesheet assets')
  }
  return {
    head: tags.join(''),
  }
}

function environmentBoolean(environment, ...keys) {
  for (const key of keys) {
    if (environment[key] === 'true') return true
    if (environment[key] === 'false') return false
  }
  return undefined
}

function environmentPositiveInteger(environment, ...keys) {
  for (const key of keys) {
    const value = Number(environment[key])
    if (Number.isInteger(value) && value > 0) return value
  }
  return undefined
}

function desktopWindowLabel(value) {
  const label = Array.isArray(value) ? value[0] : value
  return typeof label === 'string' &&
    (label === 'main' ||
      label === 'popout-window' ||
      label === 'system-drag-panel' ||
      /^workspace-[a-zA-Z0-9_-]+$/.test(label))
    ? label
    : 'main'
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, item]) =>
        item !== undefined && item !== null && (typeof item !== 'string' || item.length > 0)
    )
  )
}

export function resolveBackendUrl(environment) {
  const value = [
    environment.WEWORK_BACKEND_URL,
    environment.WEGENT_BACKEND_URL,
    environment.VITE_WEGENT_BACKEND_URL,
  ].find(candidate => typeof candidate === 'string' && candidate.trim())
  if (!value) return null
  const url = new URL(value.trim())
  const segments = url.pathname.split('/').filter(Boolean)
  const apiIndex = segments.indexOf('api')
  url.pathname = apiIndex >= 0 ? `/${segments.slice(0, apiIndex).join('/')}` : url.pathname
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

export function resolveSocketUrl(environment) {
  const value = [
    environment.WEWORK_SOCKET_URL,
    environment.WEGENT_SOCKET_URL,
    environment.VITE_WEGENT_SOCKET_URL,
  ].find(candidate => typeof candidate === 'string' && candidate.trim())
  if (!value) return null
  const url = new URL(value.trim())
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new Error(`Unsupported Wework socket URL protocol: ${url.protocol}`)
  }
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

async function proxyHttpRequest(req, res, backendUrl, sourcePath, targetPath) {
  const source = new URL(req.url ?? sourcePath, 'http://localhost')
  const target = new URL(backendUrl)
  target.pathname = `${target.pathname.replace(/\/+$/, '')}${source.pathname.replace(
    sourcePath,
    targetPath
  )}`
  target.search = source.search
  const upstreamRequest = requestFor(target)({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || undefined,
    method: req.method,
    path: `${target.pathname}${target.search}`,
    headers: proxyHeaders(req.headers, target.host),
  })
  upstreamRequest.on('response', upstream => {
    res.writeHead(upstream.statusCode ?? 502, upstream.headers)
    upstream.pipe(res)
  })
  upstreamRequest.on('error', error => {
    if (res.headersSent) {
      res.destroy(error)
      return
    }
    res.writeHead(502, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(
      JSON.stringify({
        detail: 'Wegent backend is unavailable',
        error: error.message,
      })
    )
  })
  req.pipe(upstreamRequest)
}

function proxyWebSocket(req, socket, head, backendUrl) {
  const source = new URL(req.url ?? SOCKET_PROXY_PATH, 'http://localhost')
  const target = new URL(backendUrl)
  const upstreamRequest = requestFor(target)({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || undefined,
    method: 'GET',
    path: `/socket.io${source.search}`,
    headers: proxyHeaders(req.headers, target.host),
  })
  upstreamRequest.on('upgrade', (response, upstream, upstreamHead) => {
    const headers = Object.entries(response.headers)
      .flatMap(([header, value]) =>
        Array.isArray(value)
          ? value.map(item => `${header}: ${item}`)
          : value === undefined
            ? []
            : [`${header}: ${value}`]
      )
      .join('\r\n')
    socket.write(
      `HTTP/1.1 ${response.statusCode ?? 101} ${
        response.statusMessage ?? 'Switching Protocols'
      }\r\n${headers}\r\n\r\n`
    )
    if (upstreamHead.length) socket.write(upstreamHead)
    if (head.length) upstream.write(head)
    upstream.pipe(socket).pipe(upstream)
  })
  upstreamRequest.on('response', response => {
    socket.write(
      `HTTP/1.1 ${response.statusCode ?? 502} ${
        response.statusMessage ?? 'Bad Gateway'
      }\r\nConnection: close\r\n\r\n`
    )
    socket.destroy()
  })
  upstreamRequest.on('error', () => socket.destroy())
  upstreamRequest.end()
}

function requestFor(url) {
  return url.protocol === 'https:' ? httpsRequest : httpRequest
}

function proxyHeaders(headers, host) {
  return {
    ...headers,
    host,
    connection: headers.connection ?? 'keep-alive',
  }
}

function escapeJsonForHtml(value) {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    character =>
      ({
        '<': '\\u003c',
        '>': '\\u003e',
        '&': '\\u0026',
        '\u2028': '\\u2028',
        '\u2029': '\\u2029',
      })[character]
  )
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
