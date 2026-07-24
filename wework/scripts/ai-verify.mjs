#!/usr/bin/env node

/**
 * Starts and controls an isolated Wework development application for AI verification.
 * The WebView performs the actions; this process only brokers authenticated loopback commands.
 */

import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAiVerifyEnvironment } from './ai-verify-environment.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const weworkDir = resolve(scriptDir, '..')
const defaultTimeoutMs = 30_000
const startupTimeoutMs = 60_000
const corsHeaders = {
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-origin': '*',
}

function usage() {
  console.error(`Usage:
  pnpm --filter wework ai:verify start
  pnpm --filter wework ai:verify <capture|snapshot|click|close-to-tray|drag|drop-file|fill|hover|navigate|pointer-move|press|select-text|wait-for|text|status|stop> --session PATH [options]

Options:
  --codex-home-initialization true
                            Seed and verify isolated first-run Codex migration
  --selector CSS_SELECTOR   Target selector (required by click, fill, press and wait-for)
  --value TEXT              Replacement value for fill
  --target SELECTOR         Event target selector for pointer-move (default: body)
                            Required destination selector for drag
  --file PATH               File to dispatch for drop-file
  --key KEY                 Keyboard key for press
  --output PATH             PNG output path for capture
  --text TEXT               Expected text for wait-for
  --visible true            Require a visible element for wait-for
  --stable MS               Require the wait-for condition to remain stable
  --timeout MS              Command timeout (default: ${defaultTimeoutMs})`)
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`)
    const key = value.slice(2)
    const next = rest[index + 1]
    if (!next || next.startsWith('--')) throw new Error(`Missing value for --${key}`)
    options[key] = next
    index += 1
  }
  return { command, options }
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

export function takeWritableCommandPoll(commandPolls) {
  let poll = commandPolls.shift()
  while (poll) {
    clearTimeout(poll.timer)
    if (!poll.closed && !poll.response.destroyed && !poll.response.writableEnded) return poll
    poll = commandPolls.shift()
  }
  return undefined
}

async function stopOwnedSessionProcesses(session) {
  if (!Number.isInteger(session.launcherPid)) return
  await signalProcessGroup(session.launcherPid, 'TERM')
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
  await signalProcessGroup(session.launcherPid, 'KILL')
}

function signalProcessGroup(processGroupId, signal) {
  return new Promise(resolvePromise => {
    execFile('/bin/kill', [`-${signal}`, `-${processGroupId}`], () => {
      // The process group may already have exited.
      resolvePromise()
    })
  })
}

async function runServer(sessionPath, token) {
  const session = JSON.parse(await readFile(sessionPath, 'utf8'))
  const queue = []
  const commandPolls = []
  const pending = new Map()
  let ready = null
  let app = null
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

        const poll = { response, timer: undefined, closed: false }
        poll.timer = setTimeout(() => {
          const index = commandPolls.indexOf(poll)
          if (index >= 0) commandPolls.splice(index, 1)
          response.writeHead(204, corsHeaders)
          response.end()
        }, defaultTimeoutMs)
        commandPolls.push(poll)
        response.once('close', () => {
          poll.closed = true
          const index = commandPolls.indexOf(poll)
          if (index < 0) return
          commandPolls.splice(index, 1)
          clearTimeout(poll.timer)
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/control-tick') {
        response.writeHead(204, corsHeaders)
        return response.end()
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
        })
      }
      if (request.method === 'POST' && url.pathname === '/command') {
        if (!ready) return json(response, 409, { error: 'Wework WebView is not ready' })
        const command = await readBody(request)
        const id = randomUUID()
        const timeoutMs = Number(command.timeoutMs) || defaultTimeoutMs
        const result = new Promise((resolvePromise, reject) =>
          pending.set(id, { resolve: resolvePromise, reject })
        )
        const nextCommand = { id, ...command }
        const poll = takeWritableCommandPoll(commandPolls)
        if (poll) {
          json(poll.response, 200, nextCommand)
        } else {
          queue.push(nextCommand)
        }
        try {
          return json(response, 200, {
            ok: true,
            value: await withTimeout(result, timeoutMs, `Timed out running ${command.action}`),
          })
        } catch (error) {
          pending.delete(id)
          return json(response, 500, { ok: false, error: String(error.message ?? error) })
        }
      }
      if (request.method === 'POST' && url.pathname === '/shutdown') {
        response.once('finish', () => {
          void stopOwnedSessionProcesses(updated).finally(() => server.close(() => process.exit(0)))
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
  app = spawn('bash', ['scripts/dev-mac-app.sh'], {
    cwd: weworkDir,
    detached: true,
    env: buildAiVerifyEnvironment(process.env, {
      controlUrl,
      token,
      codexHome,
      nativeCodexHome,
      verifyCodexHomeInitialization: session.verifyCodexHomeInitialization,
      deviceId: session.deviceId,
      appIdentifier: `io.wecode.wework.ai-verify.${session.deviceId.replaceAll('-', '')}`,
      executorHome,
      sessionDirectory: session.directory,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await writeFile(sessionPath, `${JSON.stringify({ ...updated, launcherPid: app.pid }, null, 2)}\n`)
  for (const stream of [app.stdout, app.stderr])
    stream?.on(
      'data',
      chunk => void import('node:fs/promises').then(({ appendFile }) => appendFile(log, chunk))
    )
  app.once('exit', code => {
    for (const waiter of pending.values())
      waiter.reject(new Error(`Wework exited with code ${code ?? 'unknown'}`))
    pending.clear()
  })
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

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  if (command === 'serve') return runServer(options.session, options.token)
  if (command === 'start') {
    const directory = join(
      weworkDir,
      'test-results',
      'ai-verify',
      `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
    )
    await mkdir(directory, { recursive: true })
    const token = randomBytes(32).toString('hex')
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
    const startupDeadline = Date.now() + (Number(options.timeout) || startupTimeoutMs)
    while (Date.now() < startupDeadline) {
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
          const status = await request(session, token, '/status')
          if (status.ready) {
            console.log(
              JSON.stringify({ session: sessionPath, controlUrl: session.controlUrl }, null, 2)
            )
            return
          }
        } catch {
          // The controller can be briefly unavailable while its process starts.
        }
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    }
    throw new Error('Timed out waiting for the Wework WebView to connect to AI verification')
  }
  if (!options.session) throw new Error('--session is required')
  const session = JSON.parse(await readFile(options.session, 'utf8'))
  if (command === 'stop') {
    await request(session, session.token, '/shutdown', 'POST')
    await stopOwnedSessionProcesses(session)
    await rm(join(session.directory, 'executor-home', 'codex', 'auth.json'), { force: true })
    return
  }
  if (command === 'status') {
    console.log(JSON.stringify(await request(session, session.token, '/status'), null, 2))
    return
  }
  const action = {
    capture: 'capture',
    snapshot: 'snapshot',
    click: 'click',
    'close-to-tray': 'closeMainWindowToTray',
    drag: 'drag',
    'drop-file': 'dropFile',
    fill: 'fill',
    hover: 'hover',
    navigate: 'navigate',
    'pointer-move': 'pointerMove',
    press: 'press',
    'select-text': 'selectText',
    'wait-for': 'waitFor',
    text: 'getText',
  }[command]
  if (!action) {
    usage()
    process.exitCode = 2
    return
  }
  const selector =
    options.selector ??
    (command === 'capture' ||
    command === 'snapshot' ||
    command === 'navigate' ||
    command === 'text' ||
    command === 'pointer-move' ||
    command === 'close-to-tray'
      ? 'body'
      : null)
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
  const value = await request(session, session.token, '/command', 'POST', {
    action,
    selector,
    target: options.target,
    value: dropFilePath ? (await readFile(dropFilePath)).toString('base64') : options.value,
    filename: dropFilePath ? basename(dropFilePath) : undefined,
    mimeType: dropFilePath ? dropFileMimeType : undefined,
    key: options.key,
    text: options.text,
    visible: options.visible === 'true',
    stableMs: options.stable ? Number(options.stable) : undefined,
    timeoutMs: options.timeout ? Number(options.timeout) : undefined,
  })
  if (command === 'capture') {
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
