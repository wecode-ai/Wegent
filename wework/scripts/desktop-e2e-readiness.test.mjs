import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { waitForDesktopScenarioStartup } from '../e2e/desktop/modules/desktop-scenario-startup.mjs'
import { pauseCollaborationExpAccountReads } from '../e2e/desktop/modules/collaboration-exp-account-setup.mjs'
import { createCollaborationExpRhythmFixture } from '../e2e/desktop/modules/collaboration-exp-rhythm.mjs'
import { requestExecutor } from '../e2e/desktop/modules/executor-rpc.mjs'

import { DesktopE2EServer } from '../e2e/desktop/modules/desktop-server.mjs'

function controller() {
  return Object.assign(Object.create(DesktopE2EServer.prototype), {
    readyCount: 1,
    readyWaiters: [],
    fatalErrorPromise: new Promise(() => {}),
  })
}

test('missing desktop readiness fails within its startup budget and removes the waiter', async () => {
  const server = controller()
  await assert.rejects(server.awaitReadyAfter(1, 10), /Timed out waiting for desktop readiness/)
  assert.equal(server.readyWaiters.length, 0)
})

test('a new desktop readiness event completes the pending startup wait', async () => {
  const server = controller()
  const pending = server.awaitReadyAfter(1, 1000)
  const ready = { windowLabel: 'plugin-development-test' }
  server.readyCount += 1
  server.readyWaiters[0].resolve(ready)
  assert.equal(await pending, ready)
  assert.equal(server.readyWaiters.length, 0)
})

test('desktop readiness that arrived before the wait is returned immediately', async () => {
  const server = controller()
  server.readyCount = 2
  server.ready = { windowLabel: 'main' }
  assert.equal(await server.awaitReadyAfter(1, 10), server.ready)
})

async function serve(t, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
  })
  return { server, url: 'http://127.0.0.1:' + server.address().port }
}

async function controlPost(control, route, body) {
  const response = await fetch(control.controlUrl + '/' + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal(response.status, 200)
  return response.json()
}

test('initial controller readiness prepares the native role before releasing the real cloud account GET', async t => {
  const deviceId = 'electron-controller-fixture'
  let role
  let identityReads = 0
  const team = { userId: 7, executionDeviceId: deviceId, version: 1, roles: [] }
  const seen = []
  const native = await serve(t, async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const rpc = JSON.parse(Buffer.concat(chunks).toString())
    assert.equal(request.url, '/wework/executor/v1/rpc')
    response.setHeader('Content-Type', 'application/json')
    if (rpc.method === 'runtime.stand_in.device_identity') {
      identityReads++
      if (identityReads === 1) {
        seen.push('registration-pending')
        response.statusCode = 500
        response.end(
          JSON.stringify({
            ok: false,
            error: {
              code: 'cloud_unavailable',
              message: 'Wait for this Runtime to register with the backend',
            },
          })
        )
        return
      }
      seen.push('registered')
    }
    const handlers = {
      'runtime.stand_in.device_identity': () => ({
        deviceId,
        backendDeviceId: 'registered-controller-device',
      }),
      'runtime.runner.catalog': () => ({ models: [{ runtime: 'codex', is_default: true }] }),
      'runtime.stand_in.binding': () => {
        assert.equal(identityReads, 2, 'Registration must finish before inspecting the role owner')
        return { target: { userId: 7 } }
      },
      'runtime.stand_in.personal.get': () => {
        assert.equal(
          identityReads,
          2,
          'Registration must finish before reading the original profile'
        )
        assert.equal(rpc.params.userId, 7)
        return team
      },
      'runtime.stand_in.get': () => ({
        id: 'collaboration-exp-rhythm',
        executionDeviceId: deviceId,
      }),
      'runtime.stand_in.save': () => {
        assert.equal(rpc.params.projectId, 'local-controller-project')
        assert.equal(rpc.params.projectStore, 'local')
        assert.equal(rpc.params.userId, 7)
        role = rpc.params.settings
        team.roles = [role]
        seen.push('native-role-saved')
        return role
      },
    }
    assert.ok(handlers[rpc.method], 'Unexpected startup RPC: ' + rpc.method)
    response.end(JSON.stringify({ ok: true, result: handlers[rpc.method]() }))
  })
  const cloud = await serve(t, (request, response) => {
    assert.equal(request.url, '/api/v1/personal-assistant')
    assert.equal(request.method, 'GET')
    assert.equal(request.headers.authorization, 'Bearer controller-fixture-token')
    seen.push('cloud-account-get')
    assert.equal(
      role?.executionDeviceId,
      deviceId,
      'The native role must exist before the first account load'
    )
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ assistant: null }))
  })
  const gate = await pauseCollaborationExpAccountReads({ backendUrl: cloud.url })
  t.after(() => gate.cleanup())
  const control = new DesktopE2EServer('/workspace')
  await control.start()
  t.after(() => control.close())
  const intercepted = once(gate.proxy.server, 'request')
  const accountRead = fetch(gate.backendUrl + '/api/v1/personal-assistant', {
    headers: { Authorization: 'Bearer controller-fixture-token' },
    signal: AbortSignal.timeout(3000),
  })
  const readFailure = accountRead.catch(() => undefined)
  await intercepted
  const startup = waitForDesktopScenarioStartup({
    control,
    waitForReady: () => control.awaitReady(),
    scenario: {
      beforeWorkbenchSetup: target =>
        gate.prepareNative(target, async target => {
          const rpc = (method, params, timeoutMs) =>
            requestExecutor(target, method, params, timeoutMs, { origin: native.url })
          await createCollaborationExpRhythmFixture(rpc, 1000).prepareRole(
            { id: 'local-controller-project' },
            7,
            1000
          )
        }),
    },
  })
  await controlPost(control, 'ready', {
    windowLabel: 'main',
    clientId: 'main',
    location: native.url,
  })
  const ready = startup.then(
    value => ({ value }),
    error => ({ error })
  )
  while (true) {
    const command = await Promise.race([
      fetch(control.controlUrl + '/commands?clientId=main&wait=1').then(response =>
        response.json()
      ),
      ready.then(result => {
        if (result.error) throw result.error
        assert.ok(role, 'Controller startup returned before native role preparation')
        return null
      }),
    ])
    if (!command) break
    assert.equal(command.action, 'fetchLocalRuntime')
    const input = JSON.parse(command.value)
    await controlPost(control, 'started', {
      id: command.id,
      clientId: 'main',
      action: command.action,
      value: command.value,
    })
    const nativeReply = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
    })
    await controlPost(control, 'results', {
      id: command.id,
      clientId: 'main',
      ok: true,
      value: JSON.stringify({
        status: nativeReply.status,
        headers: Object.fromEntries(nativeReply.headers),
        body: await nativeReply.text(),
      }),
    })
  }
  const result = await ready
  if (result.error) throw result.error
  assert.deepEqual(
    seen,
    ['registration-pending', 'registered', 'native-role-saved'],
    'Account loading must remain paused through common startup UI setup'
  )
  gate.release()
  assert.deepEqual(await (await accountRead).json(), { assistant: null })
  await readFailure
  assert.deepEqual(seen, [
    'registration-pending',
    'registered',
    'native-role-saved',
    'cloud-account-get',
  ])
})

test('the optional startup preparation preserves default readiness when absent', async t => {
  const control = new DesktopE2EServer('/workspace')
  await control.start()
  t.after(() => control.close())
  const startup = waitForDesktopScenarioStartup({
    control,
    waitForReady: () => control.awaitReady(),
  })
  await controlPost(control, 'ready', {
    windowLabel: 'main',
    clientId: 'main',
    location: 'http://127.0.0.1:43110/',
  })
  assert.equal(await startup, control.ready)
  assert.equal(control.commandHistory.length, 0)
})

test('failed native preparation cancels the initial account request without forwarding it', async t => {
  let forwarded = 0
  const cloud = await serve(t, (_request, response) => {
    forwarded++
    response.end('{}')
  })
  const gate = await pauseCollaborationExpAccountReads({ backendUrl: cloud.url })
  t.after(() => gate.cleanup())
  const intercepted = once(gate.proxy.server, 'request')
  const accountRead = fetch(gate.backendUrl + '/api/v1/personal-assistant', {
    signal: AbortSignal.timeout(1000),
  })
  const rejection = assert.rejects(accountRead)
  await intercepted
  await assert.rejects(
    () =>
      gate.prepareNative({}, async () => {
        throw Error('native preparation failed')
      }),
    /native preparation failed/
  )
  await rejection
  assert.equal(forwarded, 0)
})
