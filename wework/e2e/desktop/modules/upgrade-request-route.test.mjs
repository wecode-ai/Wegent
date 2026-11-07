import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { routeUpgradeRequests, upgradeTransportScript } from './upgrade-request-route.mjs'
import { verifyUpgradeStartup } from './upgrade-startup-probe.mjs'

const require = createRequire(new URL('../../../electron/package.json', import.meta.url))

test('diagnostic startup reports release selection without changing the relaunch', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wework-release-diagnostics-'))
  const root = join(home, 'releases')
  const previous = process.env.WEWORK_UPGRADE_DIAGNOSTIC_CHECKPOINT
  const observations = []
  const launches = []
  const app = new EventEmitter()
  app.getVersion = () => '2.0.0'
  app.getPath = () => home
  app.isReady = () => false
  app.whenReady = () => new Promise(() => {})
  app.commandLine = { removeSwitch() {} }
  app.relaunch = options => launches.push(options)
  const session = { defaultSession: { webRequest: { onBeforeRequest() {} } } }
  try {
    await mkdir(root)
    await writeFile(join(root, 'active'), 'source')
    await writeFile(join(root, 'activation.json'), JSON.stringify({ rollbackRequested: true }))
    process.env.WEWORK_UPGRADE_DIAGNOSTIC_CHECKPOINT = 'app-rollback-recovery'
    const childProcess = {
      argv: ['/installed/WeWork', '--inspect-brk=127.0.0.1:0'],
      execArgv: [],
      execPath: '/installed/WeWork',
      env: { HOME: home, WEWORK_RELEASE_ROOT: root },
      pid: 42,
      getBuiltinModule: name =>
        ({
          fs,
          path,
          module: { createRequire: () => () => ({ app, session, dialog: { showErrorBox() {} } }) },
        })[name],
    }
    runInNewContext(upgradeTransportScript('http://127.0.0.1:8000', childProcess.argv[1]), {
      process: childProcess,
      console: { log: (name, payload) => observations.push([name, JSON.parse(payload)]) },
      setInterval: () => ({ unref() {} }),
      clearInterval() {},
    })
    app.relaunch({ execPath: '/installed/wework-launcher', args: ['release-root'] })
    assert.equal(observations[0][1].selected, 'source')
    assert.equal(JSON.parse(observations[0][1].pending).rollbackRequested, true)
    assert.equal(observations[0][1].version, '2.0.0')
    assert.equal(observations[1][1].nextExecutable, '/installed/wework-launcher')
    assert.equal(launches[0].execPath, '/installed/wework-launcher')
    assert.deepEqual(Array.from(launches[0].args), ['release-root'])
  } finally {
    if (previous === undefined) delete process.env.WEWORK_UPGRADE_DIAGNOSTIC_CHECKPOINT
    else process.env.WEWORK_UPGRADE_DIAGNOSTIC_CHECKPOINT = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('installs transport before whenReady consumers when the ready event follows resolution', async () => {
  const app = new EventEmitter()
  const ready = Promise.withResolvers()
  let installed = false
  let listener
  app.isReady = () => false
  app.whenReady = () => ready.promise
  app.commandLine = { removeSwitch() {} }
  app.relaunch = () => {}
  const session = {
    defaultSession: {
      webRequest: {
        onBeforeRequest(_filter, callback) {
          installed = true
          listener = callback
        },
      },
    },
  }
  const process = {
    argv: ['electron', '--inspect-brk=127.0.0.1:0', 'app'],
    execArgv: [],
    execPath: '/electron',
    getBuiltinModule: () => ({ createRequire: () => () => ({ app, session }) }),
  }
  runInNewContext(upgradeTransportScript('http://127.0.0.1:8000', process.argv[1]), {
    process,
    console,
  })
  const request = app.whenReady().then(() => {
    assert.equal(installed, true, 'The first ready-promise consumer must see its transport')
    let redirect
    listener(
      {
        url: 'https://github.com/wecode-ai/Wegent/releases/download/wework-updater/manifest.json',
      },
      result => (redirect = result.redirectURL)
    )
    assert.equal(redirect, 'http://127.0.0.1:8000/manifest.json')
  })
  // Electron resolves its ready promise before notifying ready-event observers.
  ready.resolve()
  await request
  app.emit('ready')
})

// Observe the first native startup without introducing a diagnostic heartbeat.
test(
  'starts fresh isolated Electron profiles in both upgrade transport modes',
  { timeout: 60_000 },
  async context => {
    const root = await mkdtemp(join(tmpdir(), 'wework-upgrade-startups-'))
    const requests = []
    const server = createServer((request, response) => {
      requests.push(request.url)
      response.end('real loopback transport')
    })
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(50_000)])
      for (let index = 0; index < 10; index++) {
        const result = await verifyUpgradeStartup({
          binary: require('electron'),
          root,
          origin: `http://127.0.0.1:${server.address().port}`,
          index,
          signal,
          recordTransportLog: index % 2 === 1,
        })
        assert.equal(requests.length, index + 1)
        assert.equal(requests[index], result.path)
        console.log('Verified isolated startup:', index, result.recordTransportLog, result.phases)
      }
    } catch (error) {
      console.error('Observed isolated startup requests:', requests)
      throw error
    } finally {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      await rm(root, { recursive: true, force: true })
    }
  }
)

test('routes the default update URL through the real Electron network stack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-upgrade-transport-'))
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.url)
    response.end('real loopback transport')
  })
  let child
  let output = ''
  let errors = ''
  try {
    await new Promise(accept => server.listen(0, '127.0.0.1', accept))
    await mkdir(join(root, 'app'))
    await writeFile(
      join(root, 'app/package.json'),
      JSON.stringify({ name: 'wework-upgrade-transport-test', main: 'main.cjs' })
    )
    await writeFile(
      join(root, 'app/main.cjs'),
      `
      const {app,net} = require('electron')
      if ([...process.argv, ...process.execArgv].some(argument => argument.startsWith('--inspect-brk=')) ||
          app.commandLine.hasSwitch('inspect-brk'))
        throw new Error('The driver pause switch must not reach application handoff code')
      app.setPath('userData', ${JSON.stringify(join(root, 'user-data'))})
      app.whenReady().then(async () => {
        const response = await net.fetch('https://github.com/wecode-ai/Wegent/releases/download/wework-updater/components-beta-macos-arm64.json')
        console.log('TRANSPORT_RESULT=' + await response.text())
        app.quit()
      }).catch(error => {console.error(error);app.exit(1)})
    `
    )
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    child = spawn(require('electron'), ['--inspect-brk=127.0.0.1:0', join(root, 'app')], {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', chunk => {
      output += chunk
    })
    child.stderr.on('data', chunk => {
      errors += chunk
    })
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(20_000) })
    await routeUpgradeRequests(child, `http://127.0.0.1:${server.address().port}`)
    assert.deepEqual(await exited, [0, null], errors)
    assert.ok(output.includes('TRANSPORT_RESULT=real loopback transport'), output)
    assert.deepEqual(requests, ['/components-beta-macos-arm64.json'])
  } catch (error) {
    console.error('Isolated Electron startup diagnostics:', {
      exitCode: child?.exitCode,
      signalCode: child?.signalCode,
      stdout: output,
      stderr: errors,
    })
    throw error
  } finally {
    child?.kill()
    server.closeAllConnections()
    await new Promise(accept => server.close(accept))
    await rm(root, { recursive: true, force: true })
  }
})
