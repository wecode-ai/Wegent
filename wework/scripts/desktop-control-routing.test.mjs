import assert from 'node:assert/strict'
import { test } from 'vitest'
import { DesktopE2EServer } from '../e2e/desktop/modules/desktop-server.mjs'
import { DEFAULT_STEP_TIMEOUT_MS } from '../e2e/desktop/modules/shared.mjs'

async function startControl(t) {
  const control = new DesktopE2EServer('/workspace')
  await control.start()
  t.onTestFinished(() => control.close())
  return control
}

async function post(control, route, body) {
  const response = await fetch(`${control.controlUrl}/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal(response.status, 200)
  return response.json()
}

async function register(control, windowLabel, clientId) {
  await post(control, 'ready', { windowLabel, clientId, location: 'http://localhost/' })
}

test('binds distinct live ports for parallel desktop checkpoints', async t => {
  const controls = await Promise.all(Array.from({ length: 16 }, () => startControl(t)))
  const urls = controls.flatMap(control => [control.url, control.controlUrl])
  assert.equal(new Set(urls).size, urls.length)
  await Promise.all(controls.map((control, index) => register(control, 'main', `main-${index}`)))
  assert.ok(controls.every(control => control.server.listening && control.controlServer.listening))
})

test('attaches a scenario after its model server has bound a live port', async t => {
  const control = await startControl(t)
  let connections = 0
  control.setDesktopScenario({
    attachServer(server) {
      assert.ok(server.listening)
      server.on('connection', () => connections++)
    },
    handleHttp(_request, response, url) {
      if (url.pathname !== '/bound-scenario') return false
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ origin: control.url }))
      return true
    },
  })
  const response = await fetch(`${control.url}/bound-scenario`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { origin: control.url })
  assert.ok(connections > 0)
})

test('delivers the runner wait budget to the renderer and preserves explicit budgets', async t => {
  const control = await startControl(t)
  await register(control, 'main', 'main-1')
  for (const options of [{}, { timeoutMs: 1200 }]) {
    const result = control.command('waitFor', 'body', options)
    const response = await fetch(`${control.controlUrl}/commands?clientId=main-1&wait=1`)
    assert.equal(response.status, 200)
    const command = await response.json()
    assert.equal(command.timeoutMs, options.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS)
    await post(control, 'started', { id: command.id, clientId: 'main-1' })
    await post(control, 'results', { id: command.id, clientId: 'main-1', ok: true, value: 'ready' })
    assert.equal(await result, 'ready')
    const diagnostic = control.commandHistory.find(entry => entry.id === command.id)
    for (const field of [
      'queuedAt',
      'deliveredAt',
      'responseFinishedAt',
      'startedAt',
      'resultReceivedAt',
    ]) {
      assert.ok(Number.isFinite(Date.parse(diagnostic[field])), `Missing ${field}`)
    }
    assert.ok(Date.parse(diagnostic.queuedAt) <= Date.parse(diagnostic.deliveredAt))
    assert.ok(Date.parse(diagnostic.deliveredAt) <= Date.parse(diagnostic.startedAt))
    assert.ok(Date.parse(diagnostic.startedAt) <= Date.parse(diagnostic.resultReceivedAt))
    assert.equal(diagnostic.actionSucceeded, true)
  }
})

test('records failed and late control results without accepting an expired command', async t => {
  const control = await startControl(t)
  await register(control, 'main', 'main-1')
  const result = control.command('waitFor', '[data-testid="terminal"]')
  const rejected = assert.rejects(result, /Terminal did not mount/)
  const response = await fetch(`${control.controlUrl}/commands?clientId=main-1`)
  const command = await response.json()
  await post(control, 'started', { id: command.id, clientId: 'main-1' })
  await post(control, 'results', {
    id: command.id,
    clientId: 'main-1',
    ok: false,
    error: 'Terminal did not mount',
  })
  await rejected
  const diagnostic = control.commandHistory.find(entry => entry.id === command.id)
  assert.equal(diagnostic.actionSucceeded, false)
  assert.ok(Number.isFinite(Date.parse(diagnostic.failedAt)))

  const late = await fetch(`${control.controlUrl}/results`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: command.id, clientId: 'main-1', ok: true, value: 'late' }),
  })
  assert.equal(late.status, 404)
  assert.ok(Number.isFinite(Date.parse(diagnostic.lateResultAt)))
  assert.equal(diagnostic.actionSucceeded, false)
  assert.equal(control.commandResults.has(command.id), false)
})

test('keeps main-window commands on main after the popout registers', async t => {
  const control = await startControl(t)
  await register(control, 'main', 'main-1')
  const ready = control.awaitReadyAfter(control.readyCount)
  await register(control, 'popout-window', 'popout-1')
  assert.equal((await ready).windowLabel, 'popout-window')
  assert.equal(control.activeControlClientId, 'main-1')

  const result = control.command('click', '[data-testid="projects-create-button"]')
  const response = await fetch(`${control.controlUrl}/commands?clientId=main-1`)
  assert.equal(response.status, 200)
  const command = await response.json()
  assert.equal(command.selector, '[data-testid="projects-create-button"]')
  await post(control, 'started', { id: command.id, clientId: 'main-1' })
  await post(control, 'results', {
    id: command.id,
    clientId: 'main-1',
    ok: true,
    value: 'project dialog opened',
  })
  assert.equal(await result, 'project dialog opened')
})

test('keeps explicit selection through new windows and background reconnects', async t => {
  const control = await startControl(t)
  await register(control, 'main', 'main-1')
  await register(control, 'popout-window', 'popout-1')
  control.activateWindow('popout-window')

  await register(control, 'workspace-task-1', 'workspace-1')
  await register(control, 'plugin-development-example', 'plugin-1')
  await register(control, 'main', 'main-2')
  assert.equal(control.activeControlClientId, 'popout-1')
  assert.equal(control.controlClientsByWindow.get('main'), 'main-2')
  assert.equal(control.controlWindowsByClient.has('main-1'), false)

  control.activateWindow('workspace-task-1')
  assert.equal(control.activeControlClientId, 'workspace-1')
})

test('updates the selected window client after a renderer reload', async t => {
  const control = await startControl(t)
  await register(control, 'main', 'main-1')
  await register(control, 'popout-window', 'popout-1')
  control.activateWindow('popout-window')
  await register(control, 'popout-window', 'popout-2')

  assert.equal(control.activeControlClientId, 'popout-2')
  assert.equal(control.controlWindowsByClient.has('popout-1'), false)
  control.activateWindow('main')
  await register(control, 'main', 'main-2')
  assert.equal(control.activeControlClientId, 'main-2')
})
