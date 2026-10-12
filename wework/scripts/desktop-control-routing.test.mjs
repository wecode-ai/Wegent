import assert from 'node:assert/strict'
import { test } from 'vitest'
import { DesktopE2EServer } from '../e2e/desktop/modules/desktop-server.mjs'

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
