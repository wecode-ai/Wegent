import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { release } from 'node:os'
import { promisify } from 'node:util'
import { routeUpgradeRequests } from './upgrade-request-route.mjs'
import { requiresMacosQuitWorkaround } from '../../../electron/src/host/macos-quit-workaround.mjs'

const forceQuit = requiresMacosQuitWorkaround(process.platform, release())
export const PROBE_EXPECTED_EXIT = forceQuit ? [null, 'SIGKILL'] : [0, null]
export const PROBE_QUIT_SCRIPT = forceQuit
  ? "app.once('quit', () => process.kill(process.pid, 'SIGKILL'))"
  : ''

export async function captureStartupNativeStack(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform !== 'linux' && process.platform !== 'darwin') return
  const command = process.platform === 'linux' ? 'sudo' : '/usr/bin/sample'
  const args =
    process.platform === 'linux'
      ? [
          '-n',
          'gdb',
          '--quiet',
          '--nx',
          '--batch',
          '-ex',
          'set pagination off',
          '-ex',
          'set debuginfod enabled off',
          '-ex',
          'set print frame-arguments none',
          '-ex',
          'thread apply all bt',
          '-p',
          String(child.pid),
        ]
      : [String(child.pid), '1', '-file', '/dev/stdout']
  try {
    const { stdout, stderr } = await promisify(execFile)(command, args, {
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    console.error('Isolated startup native stack:', stdout, stderr)
  } catch (error) {
    console.error('Isolated startup native stack unavailable:', {
      code: error.code,
      stdout: error.stdout,
      stderr: error.stderr,
    })
  }
}

async function createProbeApp(root, index) {
  const profile = join(root, `startup-${index}`)
  const appPath = join(profile, 'app')
  const tracePath = join(profile, 'startup.json')
  await mkdir(appPath, { recursive: true })
  await writeFile(join(appPath, 'package.json'), JSON.stringify({ main: 'main.cjs' }))
  const path = `/components-beta-macos-arm64.json?startup=${index}`
  await writeFile(
    join(appPath, 'main.cjs'),
    `
    const {app,net} = require('electron')
    ${PROBE_QUIT_SCRIPT}
    const {writeFileSync} = require('node:fs')
    const pauseArgument = [...process.argv, ...process.execArgv].some(value => value.startsWith('--inspect-brk='))
    const pauseSwitch = app.commandLine.hasSwitch('inspect-brk')
    const state = {pauseArgument,pauseSwitch,events:[]}
    const mark = phase => {
      state.phase = phase
      state.events.push(phase)
      state.ready = app.isReady()
      writeFileSync(${JSON.stringify(tracePath)}, JSON.stringify(state))
    }
    process.on('uncaughtExceptionMonitor', error => {
      state.error = {name:error.name,code:error.code,message:error.message}
      mark('uncaught-exception')
    })
    mark('entry')
    if (pauseArgument || pauseSwitch) throw new Error('The driver pause switch reached application code')
    app.setPath('userData', ${JSON.stringify(join(profile, 'user-data'))})
    mark('profile-configured')
    app.once('will-finish-launching', () => mark('will-finish-launching'))
    app.once('ready', () => mark('ready-event'))
    app.whenReady().then(async () => {
      mark('fetch-start')
      const response = await net.fetch(${JSON.stringify(`https://github.com/wecode-ai/Wegent/releases/download/wework-updater${path}`)})
      mark('response-headers')
      const text = await response.text()
      mark('fetch-complete')
      process.stdout.write('PROBE_RESULT=' + text + '\\n', () => app.quit())
    }).catch(error => {mark('fetch-error');console.error(error);app.exit(1)})
    mark('ready-handler-registered')
    `
  )
  return { profile, appPath, tracePath, path }
}

export async function verifyUpgradeStartup({
  binary,
  root,
  origin,
  index,
  signal,
  recordTransportLog,
}) {
  signal.throwIfAborted()
  const { profile, appPath, tracePath, path } = await createProbeApp(root, index)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(binary, ['--inspect-brk=127.0.0.1:0', appPath], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', data => (stdout += data))
  child.stderr.on('data', data => (stderr += data))
  const abort = () => child.kill('SIGKILL')
  signal.addEventListener('abort', abort, { once: true })
  try {
    const [exited] = await Promise.all([
      once(child, 'close', {
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      }),
      routeUpgradeRequests(
        child,
        origin,
        recordTransportLog ? join(profile, 'transport.log') : undefined
      ),
    ])
    assert.deepEqual(exited, PROBE_EXPECTED_EXIT, stderr)
    assert.ok(stdout.includes('PROBE_RESULT=real loopback transport'), stdout)
    const state = JSON.parse(await readFile(tracePath, 'utf8'))
    assert.equal(state.pauseArgument, false)
    assert.equal(state.pauseSwitch, false)
    assert.equal(state.phase, 'fetch-complete')
    return { path, phases: state.events, recordTransportLog }
  } catch (error) {
    // Inspect only this probe's synthetic child, after failure and before cleanup.
    await captureStartupNativeStack(child)
    console.error('Isolated startup probe diagnostics:', {
      index,
      recordTransportLog,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      stdout,
      stderr,
      startup: await readFile(tracePath, 'utf8').catch(error => error.code),
    })
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
  }
}
