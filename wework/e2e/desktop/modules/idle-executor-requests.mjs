import assert from 'node:assert/strict'

const EXECUTOR_PATH = '/wework/executor/v1'
const BOOTSTRAP_REQUESTS = new Set([
  'runtime.keybindings.get',
  'executor.backend.configure',
  'runtime.connectors.clear',
  'runtime.codex.runtime_config.update',
  'runtime.codex.ensure_started',
  'runtime.models.sync_creation_profiles',
  'runtime.codex.models.list',
  'executor.plugins.initialize_bundled_marketplace',
  'runtime.codex.plugin.reconcile_bundled_marketplace',
  'runtime.codex.plugin.sync_bundled',
  'executor.plugins.personal.list',
  'executor.plugins.store.list',
  'executor.plugins.links.list',
  'executor.codex_home.config.read',
  'codex.app_server_request',
  'device.execute_command',
  'projects.list',
  'files.list',
  'todos.list',
])

/** Retain protocol identity and flags, never RPC bodies, headers or query strings. */
export function summarizeExecutorTraffic(events) {
  const navigation = events.find(
    event => event.method === 'Network.requestWillBeSent' && event.params.type === 'Document'
  )
  assert.ok(navigation, 'The real main renderer was not reloaded during observation')
  const responses = new Map()
  const failures = new Set()
  for (const event of events) {
    if (event.method === 'Network.responseReceived')
      responses.set(event.params.requestId, event.params.response.status)
    if (event.method === 'Network.loadingFailed') failures.add(event.params.requestId)
  }
  return events.flatMap(event => {
    if (event.method !== 'Network.requestWillBeSent' || event.timestamp < navigation.timestamp)
      return []
    const { request, requestId } = event.params
    const path = new URL(request.url).pathname
    if (path !== EXECUTOR_PATH && !path.startsWith(`${EXECUTOR_PATH}/`)) return []
    let method = path === EXECUTOR_PATH ? 'executor.describe' : 'executor.events'
    let params = {}
    if (path === `${EXECUTOR_PATH}/rpc`) {
      let body
      try {
        body = JSON.parse(request.postData)
      } catch {
        assert.fail('Executor RPC request is not valid JSON')
      }
      assert.equal(typeof body?.method, 'string', 'Executor RPC method is missing')
      method = body.method
      params = body.params ?? {}
    } else {
      assert.ok(
        [EXECUTOR_PATH, `${EXECUTOR_PATH}/events`].includes(path),
        'Unexpected Executor route'
      )
    }
    return [
      {
        method,
        at: event.timestamp,
        status: responses.get(requestId),
        failed: failures.has(requestId),
        pendingOnly: params.pendingOnly === true,
        preferCached: params.preferCached === true,
        ...(method === 'runtime.stand_in.telemetry.configure'
          ? { consentEnabled: params.enabled }
          : {}),
      },
    ]
  })
}

export function assertIdleExecutorTraffic(rows, windows) {
  const count = method => rows.filter(row => row.method === method).length
  assert.equal(
    count('runtime.worktrees.capabilities'),
    1,
    'Startup rediscovered worktree capabilities'
  )
  assert.equal(
    count('runtime.stand_in.telemetry.configure'),
    1,
    'Consent was written more than once'
  )
  assert.equal(count('executor.events'), 1, 'Renderer subscribers opened duplicate SSE streams')
  const consent = rows.find(row => row.method === 'runtime.stand_in.telemetry.configure')
  assert.equal(consent.consentEnabled, false, 'The isolated fixture must decline telemetry')
  assert.equal(consent.status, 200, 'Consent synchronization did not succeed')
  for (const row of rows) {
    assert.equal(row.failed, false, `Executor transport failed: ${row.method}`)
    assert.ok(row.status === undefined || row.status === 200, `Executor RPC failed: ${row.method}`)
    assert.ok(
      [
        'executor.describe',
        'executor.events',
        'runtime.tasks.list',
        'runtime.worktrees.capabilities',
        'runtime.stand_in.telemetry.configure',
      ].includes(row.method) || BOOTSTRAP_REQUESTS.has(row.method),
      `Unclassified Executor request: ${row.method}`
    )
  }
  for (const window of windows) {
    assert.ok(window.end - window.start >= 6_000, `${window.name} did not cross a poll interval`)
    const observed = rows.filter(row => row.at >= window.start && row.at <= window.end)
    const pending = observed.filter(row => row.method === 'runtime.tasks.list')
    assert.ok(pending.length > 0, `${window.name} stopped pending-interaction discovery`)
    assert.ok(
      observed.some(row => row.method === 'executor.describe'),
      `${window.name} lost identity checks`
    )
    for (const row of pending)
      assert.ok(
        row.pendingOnly && row.preferCached,
        `${window.name} reloaded the full task catalog`
      )
    assert.ok(
      !observed.some(row =>
        [
          'runtime.worktrees.capabilities',
          'runtime.stand_in.telemetry.configure',
          'executor.events',
        ].includes(row.method)
      ),
      `${window.name} repeated startup configuration or discovery`
    )
  }
}
