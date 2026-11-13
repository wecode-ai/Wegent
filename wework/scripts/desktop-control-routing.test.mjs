// @vitest-environment node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { onTestFinished, test, vi } from 'vitest'
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

test('quit completes on the real process exit when the renderer cannot send its result', async t => {
  const control = await startControl(t)
  await register(control, 'main', 'main-1')
  const child = spawn(process.execPath, ['-e', "process.stdin.on('data', () => process.exit(0))"])
  t.onTestFinished(() => {
    if (child.exitCode === null) child.kill()
  })
  await once(child, 'spawn')
  const quitting = control.command('quitApp', 'body', { exitProcessId: child.pid, timeoutMs: 1000 })
  const response = await fetch(`${control.controlUrl}/commands?clientId=main-1&wait=1`)
  const command = await response.json()
  assert.equal(command.exitProcessId, undefined, 'The process observer belongs only to the runner')
  await post(control, 'started', { id: command.id, clientId: 'main-1' })
  const exited = once(child, 'exit')
  child.stdin.end('quit')
  await exited
  assert.equal(await quitting, 'exited')
  assert.equal(control.commandResults.size, 0)
  assert.ok(
    control.controlTransportHistory.some(
      event =>
        event.event === 'process-exited' &&
        event.commandId === command.id &&
        event.exitProcessId === child.pid
    )
  )
}, 10_000)

test('quit acknowledgement cannot pass while the host process remains alive', async t => {
  const control = await startControl(t)
  await register(control, 'main', 'main-1')
  const quitting = control.command('quitApp', 'body', { exitProcessId: process.pid, timeoutMs: 50 })
  const rejected = assert.rejects(quitting, /did not quit before restart/)
  const response = await fetch(`${control.controlUrl}/commands?clientId=main-1&wait=1`)
  const command = await response.json()
  await post(control, 'started', { id: command.id, clientId: 'main-1' })
  await post(control, 'results', { id: command.id, clientId: 'main-1', ok: true })
  await rejected
  assert.equal(control.commandResults.size, 0)
})

test('process exit observation preserves explicit quit errors', async t => {
  const control = await startControl(t)
  await register(control, 'main', 'main-1')
  const quitting = control.command('quitApp', 'body', { exitProcessId: process.pid })
  const rejected = assert.rejects(quitting, /quit rejected/)
  const response = await fetch(`${control.controlUrl}/commands?clientId=main-1&wait=1`)
  const command = await response.json()
  await post(control, 'started', { id: command.id, clientId: 'main-1' })
  await post(control, 'results', {
    id: command.id,
    clientId: 'main-1',
    ok: false,
    error: 'quit rejected',
  })
  await rejected
  await assert.rejects(
    control.command('snapshot', 'body', { exitProcessId: process.pid }),
    /only valid for quitting/
  )
})

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

test('accepts an in-flight runtime result after the control client reconnects', async t => {
  const control = await startControl(t)
  await register(control, 'main', 'main-1')
  const result = control.command('fetchLocalRuntime', 'body', {
    preserveResultAcrossClientReplacement: true,
  })
  const response = await fetch(`${control.controlUrl}/commands?clientId=main-1&wait=1`)
  const command = await response.json()
  await post(control, 'started', { id: command.id, clientId: 'main-1' })

  await register(control, 'main', 'main-2')
  assert.equal(control.commandResults.has(command.id), true)
  const late = await fetch(`${control.controlUrl}/results`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: command.id,
      clientId: 'main-1',
      ok: true,
      value: '{"status":200,"body":"completed"}',
    }),
  })
  assert.equal(late.status, 200)
  assert.equal(await result, '{"status":200,"body":"completed"}')
  assert.ok(control.controlCommandAvailableAt.get('main-2') > Date.now())
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

test.each(['result-first', 'replacement-first'])(
  'completes an explicitly refreshing click in %s order without changing its timeout',
  async order => {
    const control = await startControl({ onTestFinished })
    await register(control, 'main', 'main-1')
    const readyCount = control.readyCount
    const result = control.command('click', '[data-testid="workbench-crash-retry"]', {
      expectClientReplacement: true,
    })
    const response = await fetch(`${control.controlUrl}/commands?clientId=main-1&wait=1`)
    const command = await response.json()
    assert.equal(command.timeoutMs, DEFAULT_STEP_TIMEOUT_MS)
    assert.equal(command.expectClientReplacement, undefined)
    await post(control, 'started', { id: command.id, clientId: 'main-1' })
    if (order === 'result-first')
      await post(control, 'results', { id: command.id, clientId: 'main-1', ok: true, value: '' })
    await register(control, 'main', 'main-2')
    assert.equal(await result, '')
    await control.awaitReadyAfter(readyCount)
    assert.equal(control.activeControlClientId, 'main-2')
    assert.equal(control.commandResults.size, 0)
  }
)

test.each(['ordinary-click', 'not-started'])('still rejects replacement for %s', async mode => {
  const control = await startControl({ onTestFinished })
  await register(control, 'main', 'main-1')
  const outcome = control
    .command('click', 'button', {
      expectClientReplacement: mode === 'not-started',
    })
    .then(
      () => null,
      error => error
    )
  const response = await fetch(`${control.controlUrl}/commands?clientId=main-1&wait=1`)
  const command = await response.json()
  if (mode === 'ordinary-click')
    await post(control, 'started', { id: command.id, clientId: 'main-1' })
  await register(control, 'main', 'main-2')
  assert.match((await outcome).message, /was replaced/)
})

test('a different window replacement cannot complete the refreshing click', async t => {
  const control = await startControl(t)
  await register(control, 'main', 'main-1')
  await register(control, 'popout-window', 'popout-1')
  const result = control.command('click', 'button', { expectClientReplacement: true })
  const response = await fetch(`${control.controlUrl}/commands?clientId=main-1&wait=1`)
  const command = await response.json()
  await post(control, 'started', { id: command.id, clientId: 'main-1' })
  await register(control, 'popout-window', 'popout-2')
  assert.equal(control.commandResults.has(command.id), true)
  await post(control, 'results', { id: command.id, clientId: 'main-1', ok: true, value: 'clicked' })
  assert.equal(await result, 'clicked')
})

test('an explicitly refreshing click still propagates execution failure', async t => {
  const control = await startControl(t)
  await register(control, 'main', 'main-1')
  const outcome = control.command('click', 'button', { expectClientReplacement: true }).then(
    () => null,
    error => error
  )
  const response = await fetch(`${control.controlUrl}/commands?clientId=main-1&wait=1`)
  const command = await response.json()
  await post(control, 'started', { id: command.id, clientId: 'main-1' })
  await post(control, 'results', {
    id: command.id,
    clientId: 'main-1',
    ok: false,
    error: 'Button missing',
  })
  assert.match((await outcome).message, /Button missing/)
})

test('non-click commands cannot opt into replacement completion', async t => {
  const control = await startControl(t)
  await register(control, 'main', 'main-1')
  await assert.rejects(
    control.command('getText', 'body', { expectClientReplacement: true }),
    /Only clicks/
  )
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
