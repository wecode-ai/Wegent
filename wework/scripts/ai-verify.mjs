#!/usr/bin/env node

/**
 * Starts and controls an isolated Wework development application for AI verification.
 * The WebView performs the actions; this process only brokers authenticated loopback commands.
 */

import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAiVerifyEnvironment } from './ai-verify-environment.mjs'
import { wrapWindowsScriptCommand } from './child-process-command.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const weworkDir = resolve(scriptDir, '..')
const repositoryDir = resolve(weworkDir, '..')
const electronDir = join(weworkDir, 'electron')
const defaultTimeoutMs = 30_000
const startupTimeoutMs = 120_000
const commandResultGraceMs = 5_000
const failedStartCleanupGraceMs = 1_000
const cleanupSessionPollMs = 50
const corsHeaders = {
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-origin': '*',
}

export const AI_VERIFY_ACTIONS = Object.freeze({
  capture: 'capture',
  'capture-browser': 'captureEmbeddedBrowser',
  'capture-popout': 'capturePopoutWindow',
  'capture-workspace': 'captureWorkspaceWindow',
  snapshot: 'snapshot',
  debug: 'getWorkbenchDebugSnapshot',
  'active-element': 'getActiveElementTestId',
  'activate-task-notification': 'activateRuntimeTaskCompletionNotification',
  click: 'click',
  'click-at': 'clickAt',
  'click-then-macrotask': 'clickThenMacrotask',
  'context-menu': 'contextMenu',
  'seed-local-project': 'seedLocalProject',
  'preview-plugin-import': 'previewPluginImport',
  'import-plugin-package': 'importPluginPackage',
  'set-local-proxy-url': 'setLocalProxyUrl',
  'set-storage': 'setLocalStorageItem',
  'get-storage': 'getLocalStorageItem',
  'remove-storage': 'removeLocalStorageItem',
  origin: 'getLocationOrigin',
  'restart-core-dsh': 'restartCoreDsh',
  'terminal-input': 'terminalInput',
  'terminal-snapshot': 'readLocalTerminalSnapshot',
  reload: 'reloadApp',
  'close-to-tray': 'closeMainWindowToTray',
  'request-close': 'requestMainWindowClose',
  'selection-offset': 'getSelectionOffset',
  'dismiss-popout': 'dismissPopoutWindow',
  drag: 'drag',
  'drop-file': 'dropFile',
  'drop-paths': 'dropPaths',
  fill: 'fill',
  'get-attribute': 'getAttribute',
  hover: 'hover',
  metrics: 'getElementMetrics',
  navigate: 'navigate',
  'paste-paths': 'pastePaths',
  'paste-text': 'pasteText',
  'pointer-move': 'pointerMove',
  press: 'press',
  submit: 'submit',
  'scroll-into-view': 'scrollIntoView',
  'select-text': 'selectText',
  'set-selection-offset': 'setSelectionOffset',
  'show-popout': 'showPopoutWindow',
  'system-drag-drop': 'completeSystemDragDrop',
  'verify-browser-inspector': 'verifyEmbeddedBrowserDetachedInspector',
  'wait-for': 'waitFor',
  'window-focus-snapshot': 'getWindowFocusSnapshot',
  text: 'getText',
  value: 'getValue',
})

const SELECTOR_OPTIONAL_COMMANDS = new Set([
  'capture',
  'capture-browser',
  'capture-popout',
  'capture-workspace',
  'snapshot',
  'debug',
  'active-element',
  'activate-task-notification',
  'click-at',
  'seed-local-project',
  'preview-plugin-import',
  'import-plugin-package',
  'set-local-proxy-url',
  'set-storage',
  'get-storage',
  'remove-storage',
  'origin',
  'restart-core-dsh',
  'terminal-snapshot',
  'reload',
  'navigate',
  'text',
  'pointer-move',
  'dismiss-popout',
  'show-popout',
  'system-drag-drop',
  'window-focus-snapshot',
  'close-to-tray',
  'request-close',
  'verify-browser-inspector',
])

function usage() {
  console.error(`Usage:
  pnpm --filter wework ai:verify start
  pnpm --filter wework ai:verify start --packaged true
  pnpm --filter wework ai:verify <${Object.keys(AI_VERIFY_ACTIONS).join('|')}|status|stop> --session PATH [options]

Options:
  --codex-home-initialization true
                            Seed and verify isolated first-run Codex migration
  --packaged true           Launch the packaged app instead of Electron source mode
  --selector CSS_SELECTOR   Target selector (required by click, fill, press and wait-for)
  --value TEXT_OR_JSON      Replacement value for fill or paste-text; JSON for
                            click-at, seed-local-project, paste-paths, or drop-paths
  --target SELECTOR         Event target selector for pointer-move (default: body)
                            Required destination for drag and click-then-macrotask
  --file PATH               File to dispatch for drop-file
  --key KEY                 Keyboard key for press
  --output PATH             PNG output path for capture
  --text TEXT               Expected text for wait-for
  --visible true            Require a visible element for wait-for
  --stable MS               Require the wait-for condition to remain stable
  --timeout MS              Startup timeout for start (default: ${startupTimeoutMs});
                            command timeout otherwise (default: ${defaultTimeoutMs})`)
}

export function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`)
    const key = value.slice(2)
    const next = rest[index + 1]
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }
    options[key] = next
    index += 1
  }
  return { command, options }
}

export function resolveStartupTimeout(timeout) {
  const configuredTimeout = timeout === undefined ? startupTimeoutMs : Number(timeout)
  if (!Number.isFinite(configuredTimeout) || configuredTimeout <= 0) {
    throw new Error('--timeout must be a finite positive number')
  }
  return configuredTimeout
}

export function resolveCommandTimeout(timeout) {
  const configuredTimeout = Number(timeout)
  return Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : defaultTimeoutMs
}

export function resolveOptionalBoolean(value, optionName) {
  if (value === undefined) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`--${optionName} must be "true" or "false"`)
}

export function validateStartOptions(options) {
  const allowedOptions = new Set(['codex-home-initialization', 'packaged', 'timeout'])
  const unexpectedOption = Object.keys(options).find(option => !allowedOptions.has(option))
  if (unexpectedOption) {
    throw new Error(`Unexpected option for start: --${unexpectedOption}`)
  }
  resolveOptionalBoolean(options.packaged, 'packaged')
}

function json(response, status, value) {
  response.writeHead(status, {
    ...corsHeaders,
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(`${JSON.stringify(value)}\n`)
}

function readBody(request) {
  return new Promise((resolvePromise, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => {
      body += chunk
    })
    request.once('end', () => {
      try {
        resolvePromise(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
    request.once('error', reject)
  })
}

function withTimeout(promise, timeoutMs, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

function authorized(request, token) {
  return request.headers.authorization === `Bearer ${token}`
}

export function acknowledgeStartedCommand(pending, started) {
  if (!pending.has(started.id)) {
    return { status: 404, value: { error: `Unknown command ${started.id}` } }
  }
  return { status: 200, value: { ok: true } }
}

async function stopOwnedSessionProcesses(session) {
  if (!Number.isInteger(session.launcherPid)) return
  await signalProcessGroup(session.launcherPid, 'TERM')
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
  await signalProcessGroup(session.launcherPid, 'KILL')
}

function signalProcessGroup(processGroupId, signal) {
  if (!Number.isInteger(processGroupId)) return Promise.resolve()
  return new Promise(resolvePromise => {
    execFile('/bin/kill', [`-${signal}`, `-${processGroupId}`], () => {
      // The process group may already have exited.
      resolvePromise()
    })
  })
}

async function removeSessionAuthLink(session) {
  if (!session?.directory) return
  await rm(join(session.directory, 'executor-home', 'codex', 'auth.json'), { force: true })
}

export async function readSessionForCleanup(sessionPath, timeoutMs = failedStartCleanupGraceMs) {
  const deadline = Date.now() + timeoutMs
  let session
  while (Date.now() <= deadline) {
    try {
      session = JSON.parse(await readFile(sessionPath, 'utf8'))
      if (Number.isInteger(session.launcherPid)) break
    } catch {
      // The controller may still be replacing the session file.
    }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    await new Promise(resolvePromise =>
      setTimeout(resolvePromise, Math.min(cleanupSessionPollMs, remainingMs))
    )
  }
  return { directory: dirname(sessionPath), ...(session ?? {}) }
}

async function cleanupFailedStart(sessionPath, controllerPid) {
  await signalProcessGroup(controllerPid, 'TERM')
  const session = await readSessionForCleanup(sessionPath)
  await stopOwnedSessionProcesses(session)
  await signalProcessGroup(controllerPid, 'KILL')
  await removeSessionAuthLink(session)
}

export function appExitMessage(appExit) {
  if (appExit?.error) return `Wework failed to start: ${appExit.error}`
  if (appExit?.signal !== null && appExit?.signal !== undefined) {
    return `Wework exited with signal ${appExit.signal}`
  }
  return `Wework exited with code ${appExit?.code ?? 'unknown'}`
}

export function startupFailureMessage(status, timeoutMs) {
  if (status?.appExited) {
    return `${appExitMessage({
      code: status.appExitCode,
      signal: status.appExitSignal,
      error: status.appExitError,
    })} before its WebView connected to AI verification`
  }
  const phase = status?.pid
    ? 'the desktop launcher was still waiting for its renderer'
    : 'the desktop launcher had not started'
  return `Timed out after ${timeoutMs}ms while ${phase}`
}

export function resolveElectronAppBinary(platform = process.platform, arch = process.arch) {
  const configured = process.env.WEWORK_ELECTRON_APP_BIN?.trim()
  if (configured) return resolve(configured)
  const platformName = platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'win32' : 'linux'
  const executable = platform === 'win32' ? 'WeWork.exe' : 'WeWork'
  const appRoot = join(weworkDir, 'electron', 'release', `WeWork-${platformName}-${arch}`)
  return platform === 'darwin'
    ? join(appRoot, 'WeWork.app', 'Contents', 'MacOS', executable)
    : join(appRoot, executable)
}

export function resolveElectronLaunch({
  packaged,
  sourceBinary,
  platform = process.platform,
  arch = process.arch,
}) {
  if (packaged) {
    return {
      command: resolveElectronAppBinary(platform, arch),
      args: [],
      cwd: weworkDir,
    }
  }
  return {
    command: sourceBinary,
    args: ['.'],
    cwd: electronDir,
  }
}

export function resolveHostTarget(platform = process.platform, arch = process.arch) {
  const target = {
    'darwin:arm64': 'aarch64-apple-darwin',
    'darwin:x64': 'x86_64-apple-darwin',
    'linux:arm64': 'aarch64-unknown-linux-gnu',
    'linux:x64': 'x86_64-unknown-linux-gnu',
    'win32:x64': 'x86_64-pc-windows-msvc',
  }[`${platform}:${arch}`]
  if (!target) throw new Error(`Unsupported Electron source platform: ${platform}/${arch}`)
  return target
}

export async function buildSourceRuntimeEnvironment(
  platform = process.platform,
  arch = process.arch
) {
  const target = resolveHostTarget(platform, arch)
  const lock = JSON.parse(await readFile(join(weworkDir, 'codex-binaries.lock.json'), 'utf8'))
  const codex = lock.targets[target]
  if (!codex?.binaryPath) throw new Error(`Codex binary is not configured for ${target}`)
  const executorTargetDir = join(repositoryDir, 'executor', 'target', 'ai-verify')
  return {
    CODEX_BINARY_PATH: join(weworkDir, 'resources', 'binaries', 'codex', target, codex.binaryPath),
    DWS_BINARY_PATH: join(
      weworkDir,
      'resources',
      'binaries',
      `dws-${target}${platform === 'win32' ? '.exe' : ''}`
    ),
    WEWORK_EXECUTOR_PATH: join(
      executorTargetDir,
      'debug',
      platform === 'win32' ? 'wegent-executor.exe' : 'wegent-executor'
    ),
    WEWORK_COMPONENT_RESOURCES_ROOT: join(electronDir, 'resources'),
    WEWORK_CORE_PLUGIN_ROOT: join(electronDir, 'resources', 'wework-core-plugins'),
    WEWORK_HARNESS_RUNTIME_ROOT: join(weworkDir, 'node_modules', '.cache', 'harness-runtime-dev'),
  }
}

async function resolveSourceElectronBinary() {
  const require = createRequire(join(electronDir, 'package.json'))
  return require('electron')
}

export function prepareElectronApp({
  packaged,
  environment = process.env,
  platform = process.platform,
  spawnProcess = spawn,
}) {
  if (packaged && environment.WEWORK_ELECTRON_APP_BIN?.trim()) return Promise.resolve()
  const script = packaged ? 'ai:verify:electron:build' : 'ai:verify:electron:prepare'
  const description = packaged ? 'Electron package build' : 'Electron source preparation'
  const preparationEnvironment = {
    ...environment,
    CI: environment.CI || '1',
  }
  return new Promise((resolvePromise, reject) => {
    const pnpmCommand = platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    const command = wrapWindowsScriptCommand(pnpmCommand, ['run', script], { platform })
    const child = spawnProcess(command.command, command.args, {
      cwd: weworkDir,
      env: preparationEnvironment,
      stdio: 'inherit',
    })
    child.once('error', error => {
      reject(new Error(`${description} failed to start: ${error.message}`))
    })
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${description} exited with code ${code ?? 'unknown'}`))
    })
  })
}

export function monitorAppProcess(app, pending, onExit) {
  const rejectPending = message => {
    for (const waiter of pending.values()) waiter.reject(new Error(message))
    pending.clear()
  }
  app.once('exit', (code, signal) => {
    const appExit = { code, signal, error: null }
    onExit(appExit)
    rejectPending(appExitMessage(appExit))
  })
  app.once('error', error => {
    const appExit = { code: null, signal: null, error: String(error.message ?? error) }
    onExit(appExit)
    rejectPending(appExitMessage(appExit))
  })
}

async function runServer(sessionPath, token) {
  const session = JSON.parse(await readFile(sessionPath, 'utf8'))
  const queue = []
  const pending = new Map()
  let ready = null
  let app = null
  let appExit = null
  let shutdownPromise = null
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          ...corsHeaders,
        })
        return response.end()
      }
      if (!authorized(request, token)) return json(response, 401, { error: 'Unauthorized' })
      if (request.method === 'POST' && url.pathname === '/ready') {
        ready = await readBody(request)
        return json(response, 200, { ok: true })
      }
      if (request.method === 'GET' && url.pathname === '/commands') {
        const command = queue.shift()
        if (command) return json(response, 200, command)
        response.writeHead(204, corsHeaders)
        return response.end()
      }
      if (request.method === 'GET' && url.pathname === '/control-tick') {
        return setTimeout(() => {
          response.writeHead(204, corsHeaders)
          response.end()
        }, 50)
      }
      if (request.method === 'POST' && url.pathname === '/started') {
        const started = await readBody(request)
        const acknowledgement = acknowledgeStartedCommand(pending, started)
        return json(response, acknowledgement.status, acknowledgement.value)
      }
      if (request.method === 'POST' && url.pathname === '/results') {
        const result = await readBody(request)
        const waiter = pending.get(result.id)
        if (!waiter) return json(response, 404, { error: `Unknown command ${result.id}` })
        pending.delete(result.id)
        result.ok
          ? waiter.resolve(result.value ?? '')
          : waiter.reject(new Error(result.error ?? 'WebView action failed'))
        return json(response, 200, { ok: true })
      }
      if (request.method === 'GET' && url.pathname === '/status') {
        return json(response, 200, {
          ready: Boolean(ready),
          readyInfo: ready,
          pid: app?.pid ?? null,
          appExited: appExit !== null,
          appExitCode: appExit?.code ?? null,
          appExitSignal: appExit?.signal ?? null,
          appExitError: appExit?.error ?? null,
          queuedCommands: queue.length,
          pendingCommands: pending.size,
        })
      }
      if (request.method === 'POST' && url.pathname === '/command') {
        if (appExit) return json(response, 410, { error: appExitMessage(appExit) })
        if (!ready) return json(response, 409, { error: 'Wework WebView is not ready' })
        const command = await readBody(request)
        const id = randomUUID()
        const timeoutMs = Number(command.timeoutMs) || defaultTimeoutMs
        const result = new Promise((resolvePromise, reject) =>
          pending.set(id, { resolve: resolvePromise, reject })
        )
        const nextCommand = { id, ...command }
        queue.push(nextCommand)
        try {
          return json(response, 200, {
            ok: true,
            value: await withTimeout(
              result,
              timeoutMs + commandResultGraceMs,
              `Timed out running ${command.action}`
            ),
          })
        } catch (error) {
          pending.delete(id)
          const queuedIndex = queue.findIndex(item => item.id === id)
          if (queuedIndex >= 0) queue.splice(queuedIndex, 1)
          return json(response, 500, { ok: false, error: String(error.message ?? error) })
        }
      }
      if (request.method === 'POST' && url.pathname === '/shutdown') {
        response.once('finish', () => {
          void shutdown(0)
        })
        json(response, 200, { ok: true })
        return
      }
      json(response, 404, { error: 'Not found' })
    })().catch(error => json(response, 500, { error: String(error.message ?? error) }))
  })
  await new Promise((resolvePromise, reject) =>
    server.listen(0, '127.0.0.1', error => (error ? reject(error) : resolvePromise()))
  )
  const address = server.address()
  const controlUrl = `http://127.0.0.1:${address.port}`
  const updated = {
    ...session,
    controlUrl,
    status: 'starting',
  }
  const shutdown = exitCode => {
    if (shutdownPromise) return shutdownPromise
    shutdownPromise = stopOwnedSessionProcesses({ launcherPid: app?.pid })
      .then(() => removeSessionAuthLink(session))
      .finally(() => {
        server.close(() => process.exit(exitCode))
        server.closeAllConnections()
      })
    return shutdownPromise
  }
  process.once('SIGINT', () => void shutdown(130))
  process.once('SIGTERM', () => void shutdown(143))
  await writeFile(sessionPath, `${JSON.stringify(updated, null, 2)}\n`)
  const log = join(session.directory, 'app.log')
  const executorHome = join(session.directory, 'executor-home')
  const codexHome = join(executorHome, 'codex')
  const nativeCodexHome = session.verifyCodexHomeInitialization
    ? join(session.directory, 'native-codex')
    : undefined
  await mkdir(codexHome, { recursive: true })
  if (nativeCodexHome) {
    await mkdir(nativeCodexHome, { recursive: true })
    await writeFile(join(nativeCodexHome, 'auth.json'), '{"test":"isolated-auth"}\n')
    await writeFile(join(nativeCodexHome, 'config.toml'), 'model = "gpt-5"\n')
  }
  const environment = buildAiVerifyEnvironment(process.env, {
    controlUrl,
    token,
    codexHome,
    nativeCodexHome,
    verifyCodexHomeInitialization: session.verifyCodexHomeInitialization,
    deviceId: session.deviceId,
    appIdentifier: `io.wecode.wework.ai-verify.${session.deviceId.replaceAll('-', '')}`,
    executorHome,
    sessionDirectory: session.directory,
  })
  const sourceEnvironment =
    session.launchMode === 'source' ? await buildSourceRuntimeEnvironment() : {}
  const launch = resolveElectronLaunch({
    packaged: session.launchMode === 'packaged',
    sourceBinary: session.launchMode === 'source' ? await resolveSourceElectronBinary() : undefined,
  })
  app = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    detached: true,
    env: {
      ...environment,
      ...sourceEnvironment,
      WEWORK_DESKTOP_RUNTIME: 'electron',
      WEWORK_E2E_CONTROL_TOKEN: token,
      WEWORK_USER_DATA_DIR: join(session.directory, 'user-data'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  monitorAppProcess(app, pending, exit => {
    appExit = exit
  })
  for (const stream of [app.stdout, app.stderr])
    stream?.on(
      'data',
      chunk => void import('node:fs/promises').then(({ appendFile }) => appendFile(log, chunk))
    )
  await writeFile(sessionPath, `${JSON.stringify({ ...updated, launcherPid: app.pid }, null, 2)}\n`)
}

async function request(session, token, path, method = 'GET', body) {
  const response = await fetch(`${session.controlUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const value = await response.json()
  if (!response.ok || value.ok === false)
    throw new Error(value.error ?? `Request failed with ${response.status}`)
  return value
}

async function waitForFreshControlClient(session, token, previousClientId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await request(session, token, '/status')
    const clientId = status.readyInfo?.clientId
    if (clientId && clientId !== previousClientId) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error('Timed out waiting for the reloaded Wework WebView to reconnect')
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  if (command === 'serve') return runServer(options.session, options.token)
  if (command === 'start') {
    validateStartOptions(options)
    const packaged = resolveOptionalBoolean(options.packaged, 'packaged') ?? false
    await prepareElectronApp({ packaged })
    const launch = resolveElectronLaunch({
      packaged,
      sourceBinary: packaged ? undefined : await resolveSourceElectronBinary(),
    })
    const directory = join(
      weworkDir,
      'test-results',
      'ai-verify',
      `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
    )
    await mkdir(directory, { recursive: true })
    const token = randomBytes(32).toString('hex')
    await readFile(launch.command)
    const sessionPath = join(directory, 'session.json')
    await writeFile(
      sessionPath,
      `${JSON.stringify(
        {
          version: 1,
          deviceId: `ai-verify-${randomUUID()}`,
          directory,
          token,
          status: 'starting',
          launchMode: packaged ? 'packaged' : 'source',
          verifyCodexHomeInitialization: options['codex-home-initialization'] === 'true',
        },
        null,
        2
      )}\n`
    )
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), 'serve', '--session', sessionPath, '--token', token],
      { detached: true, stdio: 'ignore' }
    )
    child.unref()
    let controllerExit = null
    let controllerError = null
    child.once('exit', (code, signal) => {
      controllerExit = { code, signal }
    })
    child.once('error', error => {
      controllerError = error
    })
    const startupTimeout = resolveStartupTimeout(options.timeout)
    const startupDeadline = Date.now() + startupTimeout
    let lastStatus = null
    try {
      while (Date.now() < startupDeadline) {
        if (controllerError) {
          throw new Error(`AI verification controller failed to start: ${controllerError.message}`)
        }
        if (controllerExit) {
          throw new Error(
            `AI verification controller exited with ${
              controllerExit.signal !== null
                ? `signal ${controllerExit.signal}`
                : `code ${controllerExit.code ?? 'unknown'}`
            } during startup`
          )
        }
        let session
        try {
          session = JSON.parse(await readFile(sessionPath, 'utf8'))
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
          await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
          continue
        }
        if (session.controlUrl) {
          try {
            lastStatus = null
            lastStatus = await request(session, token, '/status')
            if (lastStatus.ready) {
              console.log(
                JSON.stringify({ session: sessionPath, controlUrl: session.controlUrl }, null, 2)
              )
              return
            }
            if (lastStatus.appExited) {
              throw new Error(startupFailureMessage(lastStatus, startupTimeout))
            }
          } catch (error) {
            if (lastStatus?.appExited) throw error
            // The controller can be briefly unavailable while its process starts.
          }
        }
        await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
      }
      throw new Error(startupFailureMessage(lastStatus, startupTimeout))
    } catch (error) {
      await cleanupFailedStart(sessionPath, child.pid)
      throw error
    }
  }
  if (!options.session) throw new Error('--session is required')
  const session = JSON.parse(await readFile(options.session, 'utf8'))
  if (command === 'stop') {
    await request(session, session.token, '/shutdown', 'POST')
    await stopOwnedSessionProcesses(session)
    await removeSessionAuthLink(session)
    return
  }
  if (command === 'status') {
    console.log(JSON.stringify(await request(session, session.token, '/status'), null, 2))
    return
  }
  const action = AI_VERIFY_ACTIONS[command]
  if (!action) {
    usage()
    process.exitCode = 2
    return
  }
  const selector = options.selector ?? (SELECTOR_OPTIONAL_COMMANDS.has(command) ? 'body' : null)
  if (!selector) throw new Error('--selector is required')
  const dropFilePath = command === 'drop-file' ? options.file : undefined
  if (command === 'drop-file' && !dropFilePath) throw new Error('--file is required')
  const dropFileExtension = dropFilePath ? extname(dropFilePath).toLowerCase() : ''
  const dropFileMimeType =
    dropFileExtension === '.png'
      ? 'image/png'
      : dropFileExtension === '.jpg' || dropFileExtension === '.jpeg'
        ? 'image/jpeg'
        : dropFileExtension === '.txt'
          ? 'text/plain'
          : 'application/octet-stream'
  const previousReady =
    command === 'reload' ? await request(session, session.token, '/status') : null
  const effectiveTimeoutMs = resolveCommandTimeout(options.timeout)
  const value = await request(session, session.token, '/command', 'POST', {
    action,
    selector,
    target: options.target,
    value: dropFilePath ? (await readFile(dropFilePath)).toString('base64') : options.value,
    filename: dropFilePath ? basename(dropFilePath) : undefined,
    mimeType: dropFilePath ? dropFileMimeType : undefined,
    key: options.key,
    text: options.text,
    visible: resolveOptionalBoolean(options.visible, 'visible'),
    stableMs: options.stable ? Number(options.stable) : undefined,
    timeoutMs: effectiveTimeoutMs,
  })
  if (command === 'reload') {
    await waitForFreshControlClient(
      session,
      session.token,
      previousReady?.readyInfo?.clientId,
      effectiveTimeoutMs
    )
  }
  if (
    command === 'capture' ||
    command === 'capture-browser' ||
    command === 'capture-popout' ||
    command === 'capture-workspace'
  ) {
    if (!options.output) throw new Error('--output is required')
    const prefix = 'data:image/png;base64,'
    if (!value.value?.startsWith(prefix)) throw new Error('Invalid screenshot payload')
    const outputPath = resolve(options.output)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, Buffer.from(value.value.slice(prefix.length), 'base64'))
    console.log(outputPath)
    return
  }
  console.log(typeof value.value === 'string' ? value.value : JSON.stringify(value.value, null, 2))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`ai:verify: ${error.message ?? error}`)
    process.exitCode = 1
  })
}
