import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
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

for (const action of [
  'waitFor',
  'getText',
  'getAttribute',
  'snapshot',
  'getBundledPluginUpdates',
  'getComposerPluginInventoryDiagnostics',
  'getConversationDiagnosticsSnapshot',
  'getLocalExecutorStatus',
  'getLocalStorageItem',
  'getLocationOrigin',
  'getPluginSyncDiagnostics',
]) {
  test(`read-only ${action} does not restart the input cooldown after readiness is observed`, async t => {
    const control = await startControl(t)
    await register(control, 'main', 'main-1')
    const previousDeadline = Date.now() - 1000
    control.controlCommandAvailableAt.set('main-1', previousDeadline)
    const result = control.command(action, 'body')
    const response = await fetch(`${control.controlUrl}/commands?clientId=main-1&wait=1`)
    const command = await response.json()
    await post(control, 'started', { id: command.id, clientId: 'main-1' })
    await post(control, 'results', { id: command.id, clientId: 'main-1', ok: true, value: 'ready' })
    assert.equal(await result, 'ready')
    assert.equal(control.controlCommandAvailableAt.get('main-1'), previousDeadline)
  })
}

test('observations preserve an active cooldown while state-changing actions still start one', async t => {
  const control = await startControl(t)
  await register(control, 'main', 'main-1')
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  t.onTestFinished(() => clock.mockRestore())
  for (const action of ['click', 'clickWhenEnabled', 'fill', 'navigate', 'setCloudSessionToken']) {
    control.controlCommandAvailableAt.delete('main-1')
    const mutation = control.command(action, 'body')
    let response = await fetch(`${control.controlUrl}/commands?clientId=main-1&wait=1`)
    let command = await response.json()
    await post(control, 'started', { id: command.id, clientId: 'main-1' })
    await post(control, 'results', { id: command.id, clientId: 'main-1', ok: true })
    await mutation
    assert.equal(control.controlCommandAvailableAt.get('main-1'), now + 250)
    clock.mockReturnValue(now + 100)
    const observation = control.command('waitFor', 'body')
    response = await fetch(`${control.controlUrl}/commands?clientId=main-1&wait=1`)
    command = await response.json()
    await post(control, 'started', { id: command.id, clientId: 'main-1' })
    await post(control, 'results', { id: command.id, clientId: 'main-1', ok: true })
    await observation
    assert.equal(control.controlCommandAvailableAt.get('main-1'), now + 250)
    clock.mockReturnValue(now)
  }
})

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
  }
})

test('delivers account credentials without retaining them in diagnostic command history', async t => {
  const control = await startControl(t)
  await register(control, 'main', 'main-1')
  const result = control.command('setCloudSessionToken', 'body', { value: 'recipient-token' })
  const response = await fetch(`${control.controlUrl}/commands?clientId=main-1&wait=1`)
  const command = await response.json()
  assert.equal(command.value, 'recipient-token')
  assert.equal(control.commandHistory.at(-1).value, '[redacted]')
  await post(control, 'started', { id: command.id, clientId: 'main-1' })
  await post(control, 'results', { id: command.id, clientId: 'main-1', ok: true })
  assert.equal(await result, '')
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

test('retires unknown and replaced clients instead of starting an empty poll loop', async t => {
  const control = await startControl(t)
  const unknown = await fetch(`${control.controlUrl}/commands?clientId=unknown&wait=1`)
  assert.equal(unknown.status, 410)
  await register(control, 'main', 'main-1')
  const arrived = new Promise(resolve => control.controlServer.once('request', resolve))
  const waiting = fetch(`${control.controlUrl}/commands?clientId=main-1&wait=1`)
  await arrived
  assert.equal(control.controlLongPolls.has('main-1'), true)
  await register(control, 'main', 'main-2')
  assert.equal((await waiting).status, 410)
  const replaced = await fetch(`${control.controlUrl}/commands?clientId=main-1&wait=1`)
  assert.equal(replaced.status, 410)
  assert.equal(control.controlLongPolls.size, 0)
})
