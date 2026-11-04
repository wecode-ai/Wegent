import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { routeUpgradeRequests } from './upgrade-request-route.mjs'

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
    const {writeFileSync} = require('node:fs')
    const pauseArgument = [...process.argv, ...process.execArgv].some(value => value.startsWith('--inspect-brk='))
    const pauseSwitch = app.commandLine.hasSwitch('inspect-brk')
    const state = {pauseArgument,pauseSwitch,events:[]}
    const mark = phase => {
      state.phase = phase
      state.events.push(phase)
      writeFileSync(${JSON.stringify(tracePath)}, JSON.stringify(state))
    }
    process.on('uncaughtExceptionMonitor', error => {
      state.error = {name:error.name,code:error.code,message:error.message}
      mark('uncaught-exception')
    })
    mark('entry')
    if (pauseArgument || pauseSwitch) throw new Error('The driver pause switch reached application code')
    app.setPath('userData', ${JSON.stringify(join(profile, 'user-data'))})
    app.once('ready', () => mark('ready-event'))
    app.whenReady().then(async () => {
      mark('fetch-start')
      const response = await net.fetch(${JSON.stringify(`https://github.com/wecode-ai/Wegent/releases/download/wework-updater${path}`)})
      mark('response-headers')
      const text = await response.text()
      mark('fetch-complete')
      console.log('PROBE_RESULT=' + text)
      app.quit()
    }).catch(error => {mark('fetch-error');console.error(error);app.exit(1)})
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
    assert.deepEqual(exited, [0, null], stderr)
    assert.ok(stdout.includes('PROBE_RESULT=real loopback transport'), stdout)
    const state = JSON.parse(await readFile(tracePath, 'utf8'))
    assert.equal(state.pauseArgument, false)
    assert.equal(state.pauseSwitch, false)
    assert.equal(state.phase, 'fetch-complete')
    return { path, phases: state.events, recordTransportLog }
  } catch (error) {
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
