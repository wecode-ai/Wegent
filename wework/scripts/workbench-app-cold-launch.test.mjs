import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { verifyWorkbenchAppColdLaunch } from '../e2e/desktop/modules/workbench-app-cold-launch.mjs'

// Protocol integration only; the registered desktop checkpoint runs real DSH and Electron.
async function fixture(
  t,
  {
    extraRenderer = false,
    runtimeStarted = true,
    appRunning = true,
    crossProcess = false,
    shortcutExecutable,
  } = {}
) {
  const resultDir = await mkdtemp(join(tmpdir(), 'wework-app-cold-protocol-'))
  const token = randomBytes(24).toString('hex')
  const app = {
    id: 'todo',
    manifest: { name: 'todo', displayName: 'Todo' },
    visible: true,
    state: appRunning ? 'running' : 'installed',
    webUrl: 'http://127.0.0.1:9123/',
  }
  const targets = [
    { id: 4, type: 'browserView', url: app.webUrl },
    { id: 6, type: 'window', url: '' },
  ]
  if (extraRenderer) targets.push({ id: 5, url: 'http://127.0.0.1/workbench' })
  const protocol = []
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    let data
    if (request.url === '/status') data = { pid: process.pid, ready: false, url: null }
    else if (request.url === '/workbench') {
      assert.equal(body.action, 'list')
      data = [app]
    } else if (body.action === 'targets') data = targets
    else if (body.action === 'detach') data = { detached: true }
    else {
      protocol.push(body)
      if (body.method === 'DOM.getDocument')
        data = {
          root: {
            nodeName: '#document',
            backendNodeId: 1,
            children: [
              {
                nodeName: 'IFRAME',
                attributes: ['data-testid', 'workbench-lightweight-frame'],
                ...(crossProcess
                  ? {}
                  : { contentDocument: { nodeName: '#document', backendNodeId: 22 } }),
              },
            ],
          },
        }
      else if (body.method === 'DOM.resolveNode') {
        assert.equal(body.params.backendNodeId, 22)
        data = { object: { objectId: 'sandbox-document' } }
      } else if (body.method === 'Runtime.releaseObject') data = {}
      else if (body.method === 'Target.getTargets')
        data = { targetInfos: [{ type: 'iframe', targetId: 'opaque-frame' }] }
      else if (body.method === 'Target.attachToTarget') {
        assert.equal(body.params.targetId, 'opaque-frame')
        data = { sessionId: 'child-session' }
      } else if (body.method === 'Page.getFrameTree') {
        assert.equal(body.sessionId, 'child-session')
        data = { frameTree: { frame: { name: 'wework-workbench-lightweight' } } }
      } else if (body.method === 'Target.detachFromTarget') {
        assert.equal(body.params.sessionId, 'child-session')
        data = {}
      } else {
        if (crossProcess) {
          assert.equal(body.method, 'Runtime.evaluate')
          assert.equal(body.sessionId, 'child-session')
          assert.match(body.params.expression, /window.weworkWorkbench/)
        } else {
          assert.equal(body.method, 'Runtime.callFunctionOn')
          assert.equal(body.params.objectId, 'sandbox-document')
          assert.match(body.params.functionDeclaration, /this.defaultView/)
        }
        data = {
          result: {
            value: {
              sdk: true,
              text: 'persisted note',
              checked: true,
              state: [{ text: 'persisted note', done: true }],
            },
          },
        }
      }
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true, data }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(resultDir, { recursive: true, force: true })
  })
  const directory = join(resultDir, 'desktop-control')
  await mkdir(directory)
  await writeFile(
    join(directory, 'main.json'),
    JSON.stringify({
      schemaVersion: 1,
      instanceId: 'isolated-unit-host',
      pid: process.pid,
      address: `127.0.0.1:${server.address().port}`,
      token,
      startedAtUnixMs: Date.now(),
    })
  )
  await writeFile(join(resultDir, 'app.log'), '')
  const commands = [],
    restarts = []
  const control = {
    readyCount: 1,
    command: async (action, selector, options) => {
      commands.push({ action, selector, options })
      if (action === 'workbenchApp') return JSON.stringify({ running: true, sdkAvailable: true })
    },
  }
  const restartDesktopApp = async options => {
    restarts.push(options)
    if (!options) {
      control.readyCount += 1
      return
    }
    await options.afterStop()
    await appendFile(
      join(resultDir, 'app.log'),
      "[startup] { step: 'desktop-control-bridge', status: 'completed' }\n"
    )
    if (runtimeStarted)
      await appendFile(
        join(resultDir, 'app.log'),
        "[startup] { step: 'core-dsh-start', status: 'completed' }\n[startup] { step: 'desktop-runtime-start', status: 'completed' }\n"
      )
    await options.waitForStartup({ app: { pid: process.pid } })
  }
  return {
    run: () =>
      verifyWorkbenchAppColdLaunch({
        control,
        installationId: 'todo',
        note: 'persisted note',
        resultDir,
        restartDesktopApp,
        shortcutExecutable,
        startupTimeoutMs: 20,
      }),
    commands,
    restarts,
    protocol,
  }
}

test('cold start observes the authenticated Host and sandbox document while allowing the required DSH runtime', async t => {
  const { run, restarts, commands, protocol } = await fixture(t)
  await run()
  assert.equal(restarts.length, 2)
  assert.deepEqual(restarts[0].startupUrls, ['wework://workbenches/todo'])
  assert.equal(restarts[1], undefined)
  assert.ok(
    commands.some(
      value =>
        value.action === 'clickWhenEnabled' && value.selector.includes('harness-app-start-todo')
    )
  )
  assert.ok(protocol.some(value => value.method === 'Runtime.releaseObject'))
})

test('an unrelated main renderer fails the cold-start gate and restores the normal process', async t => {
  const { run, restarts } = await fixture(t, { extraRenderer: true })
  await assert.rejects(run(), /unrelated renderer/)
  assert.equal(restarts.length, 2)
  assert.equal(restarts[1], undefined)
})

test('native shortcut cold startup executes the generated launcher without substituting a URL launch', async t => {
  const shortcutExecutable = join(tmpdir(), 'Todo.app', 'Contents', 'MacOS', 'launch-workbench')
  const { run, restarts } = await fixture(t, { shortcutExecutable })
  await run()
  assert.deepEqual(restarts[0].launchCommand, { command: shortcutExecutable, args: [] })
  assert.equal(restarts[0].startupUrls, undefined)
  assert.equal(restarts[1], undefined)
})

test('missing DSH preparation fails even if a mocked application page is visible', async t => {
  const { run, restarts } = await fixture(t, { runtimeStarted: false })
  await assert.rejects(run(), /did not prepare the shared DSH runtime/)
  assert.equal(restarts.length, 2)
})

test('a visible window without the requested running DSH installation cannot satisfy cold startup', async t => {
  const { run, restarts } = await fixture(t, { appRunning: false })
  await assert.rejects(run(), /did not run the requested DSH installation/)
  assert.equal(restarts.length, 2)
})

test('an opaque frame in another renderer process is read through its own default script context', async t => {
  const { run, protocol } = await fixture(t, { crossProcess: true })
  await run()
  assert.ok(protocol.some(value => value.method === 'Target.attachToTarget'))
  assert.ok(protocol.some(value => value.method === 'Target.detachFromTarget'))
})
