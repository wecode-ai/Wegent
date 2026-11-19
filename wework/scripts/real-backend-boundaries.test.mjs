import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { BackendFaultGate } from '../e2e/desktop/modules/backend-fault-gate.mjs'
import { SitesProtocolFixture } from '../e2e/desktop/modules/sites-protocol-fixture.mjs'
import { TransportFaultProxy } from '../e2e/desktop/modules/transport-fault-proxy.mjs'
import { startCloudLoginProxyFixture } from '../e2e/desktop/modules/cloud-login-proxy-fixtures.mjs'
import { LocalSandboxProcessController } from '../e2e/desktop/modules/sandbox-process-controller.mjs'

test('the public sandbox provider restarts an actual process without serving Nevis replies', async () => {
  const launch = async () => {
    const child = spawn(
      process.execPath,
      ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
      {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      }
    )
    await once(child, 'message')
    return child
  }
  let child = await launch()
  let transition
  const controller = await new LocalSandboxProcessController(sandboxId => {
    assert.equal(sandboxId, 'owned-test-sandbox')
    transition = (async () => {
      const exited = once(child, 'exit')
      child.kill()
      await exited
      child = await launch()
    })()
  }).start()
  try {
    const previousPid = child.pid
    for (const path of [
      '/metrics/raw_query',
      '/apis/sandboxes/v1/managers/test/sandboxes/test/restart',
    ]) {
      assert.equal((await fetch(controller.endpoint + path, { method: 'POST' })).status, 404)
    }
    assert.equal(controller.requests.length, 0)
    assert.equal(
      (
        await fetch(controller.endpoint + '/e2e/sandboxes/owned-test-sandbox/restart', {
          method: 'POST',
        })
      ).status,
      202
    )
    await transition
    assert.notEqual(child.pid, previousPid)
    assert.equal(child.exitCode, null)
    assert.deepEqual(await controller.waitForRestartRequest(0), { sandboxId: 'owned-test-sandbox' })
  } finally {
    await transition
    if (child.exitCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    await controller.stop()
  }
})

test('cloud login proxy forwards Backend replies and approves the actual observed session once', async () => {
  let approvals = 0
  let approved
  const approval = new Promise(resolve => {
    approved = resolve
  })
  const upstream = createServer((request, response) => {
    if (request.url.endsWith('/approve')) {
      assert.equal(request.headers.authorization, 'Bearer unit-owner-token')
      approvals += 1
      approved()
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ source: 'upstream', path: request.url }))
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const fixture = await startCloudLoginProxyFixture({
    backendUrl: `http://127.0.0.1:${upstream.address().port}`,
    authToken: 'unit-owner-token',
  })
  const forward = (path, origin = fixture.backendUrl) =>
    new Promise((resolve, reject) => {
      const request = httpRequest(fixture.proxyUrl, { path: origin + path }, response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.once('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()))
          } catch (error) {
            reject(error)
          }
        })
      })
      request.once('error', reject)
      request.end()
    })
  try {
    const path = '/api/auth/wework/sessions/test-session/poll?poll_token=private-poll-token'
    await assert.rejects(
      forward(path, `http://unrelated.invalid:${upstream.address().port}`),
      SyntaxError
    )
    await assert.rejects(
      forward(path, `http://${fixture.backendHost}:${upstream.address().port + 1}`),
      SyntaxError
    )
    assert.deepEqual(fixture.backendRequests, [])
    assert.equal(approvals, 0)
    assert.deepEqual(await forward(path), { source: 'upstream', path })
    assert.equal(approvals, 0)
    await forward(path)
    await approval
    await forward(path)
    assert.equal(approvals, 1)
    assert.equal(JSON.stringify(fixture.proxyRequests).includes('private-poll-token'), false)
    assert.equal(JSON.stringify(fixture.backendRequests).includes('private-poll-token'), false)
  } finally {
    await fixture.stop()
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
  }
})

test('a held real acknowledgement can be lost after inspecting its committed response', async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': '18' })
    response.end('{"committed":true}')
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const proxy = await new TransportFaultProxy(`http://127.0.0.1:${upstream.address().port}`).start()
  proxy.rule = () => 'hold-response'
  try {
    const pending = fetch(proxy.url)
      .then(response => response.json())
      .then(
        () => null,
        error => error
      )
    const deadline = Date.now() + 10_000
    while (!proxy.requests[0]?.readHeldResponse?.()) {
      assert.ok(Date.now() < deadline, 'The upstream response was not observed')
      await new Promise(resolve => setImmediate(resolve))
    }
    const entry = proxy.requests[0]
    assert.equal(entry.readHeldResponse().body.toString(), '{"committed":true}')
    assert.equal(entry.dropHeldResponse(), true)
    assert.equal(entry.dropHeldResponse(), false)
    assert.ok((await pending) instanceof TypeError)
    assert.equal(entry.committedResponseDropped, true)
    proxy.rule = () => null
    assert.deepEqual(await (await fetch(proxy.url)).json(), { committed: true })
  } finally {
    await proxy.stop()
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
  }
})

test('Backend faults hold or disconnect transport and recovery delivers the upstream response', async () => {
  const received = []
  const upstream = createServer((request, response) => {
    received.push(request.url)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ source: 'upstream', path: request.url }))
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const gate = await new BackendFaultGate(
    `http://127.0.0.1:${upstream.address().port}`,
    '/api/models/unified',
    true
  ).start()
  try {
    const held = fetch(`${gate.url}/api/models/unified`).then(
      () => null,
      error => error
    )
    await gate.awaitBlocked('/api/models/unified')
    assert.deepEqual(received, [])
    assert.deepEqual(
      await (await fetch(`${gate.url}/api/runtime-work/im-notifications/presence`)).json(),
      { source: 'upstream', path: '/api/runtime-work/im-notifications/presence' }
    )
    gate.fail()
    assert.ok((await held) instanceof TypeError)
    await gate.awaitFailure()
    await assert.rejects(fetch(`${gate.url}/api/models/unified`), TypeError)
    gate.restore()
    const result = await fetch(`${gate.url}/api/models/unified`)
    assert.equal(result.status, 200)
    assert.deepEqual(await result.json(), { source: 'upstream', path: '/api/models/unified' })
    assert.equal(received.filter(path => path === '/api/models/unified').length, 1)
  } finally {
    await gate.stop()
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
  }
})

test('Sites protocol persists management writes and never returns secret values', async () => {
  const sites = await new SitesProtocolFixture().start()
  const headers = {
    'content-type': 'application/json',
    'x-wegent-username': 'unit-user',
    'idempotency-key': 'unit-operation',
  }
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`${sites.url}/api/v1/projects${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    assert.ok(response.ok)
    return response.status === 204 ? null : response.json()
  }
  try {
    const list = await request('/search?username=unit-user&limit=100')
    assert.equal(list.items[0].owner_username, 'unit-user')
    const miniapps = await request('/search?username=unit-user&app_type=miniapp')
    assert.equal(miniapps.items[0].id, 'prj_e2e_mini')
    assert.equal(miniapps.items[0].project_type, 'miniapp')
    const path = '/prj_e2e_product'
    const revision = await request(`${path}/environment-variables`, 'PATCH', {
      expected_revision_id: null,
      operations: [{ op: 'upsert', key: 'API_TOKEN', type: 'secret', value: 'must-not-return' }],
    })
    assert.equal(JSON.stringify(revision).includes('must-not-return'), false)
    assert.deepEqual(await request(`${path}/environment-variables`), {
      revision_id: revision.id,
      revision_number: 1,
      project_id: 'prj_e2e_product',
      items: revision.variables,
    })
    const policy = await request(`${path}/access`, 'PUT', {
      username: 'unit-user',
      audience: 'custom',
      subjects: 'viewer-b,viewer-a,viewer-b',
    })
    assert.deepEqual(policy.subjects, ['viewer-a', 'viewer-b'])
    await request(`${path}/collaborators`, 'POST', { subject: 'viewer-a' })
    assert.equal((await request(`${path}/collaborators`)).items.length, 1)
    await request(`${path}/collaborators/viewer-a`, 'DELETE')
    assert.deepEqual((await request(`${path}/collaborators`)).items, [])
  } finally {
    await sites.stop()
  }
})
