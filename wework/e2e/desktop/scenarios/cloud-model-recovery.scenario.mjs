import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { verifyCloudModelRecovery } from '../modules/cloud-model-recovery.mjs'
import { withConnectorMcp } from '../modules/connector-mcp-client.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { managedRoot } from '../modules/managed-plugin-root.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'
import { readCapabilityManifest } from '../modules/plugin-runtime-path-fixture.mjs'
import { CLOUD_PUBLIC_MODEL_NAME, fetchJson } from '../modules/shared.mjs'

async function deleteFixture(cloud, path) {
  const response = await fetch(`${cloud.backendUrl}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${cloud.authToken}` },
  })
  assert.equal(response.status, 204, `Fixture cleanup failed for ${path}`)
}

async function cleanupFixtures(cleanups) {
  const errors = []
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Connector fixture cleanup failed')
}

function connectorRefresh(rpc, request, configure) {
  return async () => {
    const issuedAt = Date.now()
    const token = await request('/api/connector-runtime/token', { method: 'POST' })
    await configure(token.access_token, issuedAt + token.expires_in * 1_000)
    const installed = await request('/api/apps/installed')
    return rpc('runtime.connectors.apps.sync', {
      apps: installed.apps
        .filter(app => app.enabled && app.callable)
        .map(app => ({
          slug: app.slug,
          name: app.runtime_name ?? app.slug,
          description: app.description ?? '',
          tools: app.tool_summaries ?? [],
        })),
    })
  }
}

async function createCallableConnector(cloud, request) {
  const slug = `renewal-spaces-${process.pid}`
  const app = await request('/api/admin/connector-apps', {
    method: 'POST',
    body: JSON.stringify({
      slug,
      name: 'Connector renewal project spaces',
      auth_type: 'none',
      transport: 'streamable-http',
      mcp_url: `${cloud.backendUrl}/api/mcp/wework-space/sse`,
      provider_headers: { Authorization: `Bearer ${cloud.authToken}` },
      tool_allowlist: ['list_spaces'],
    }),
  })
  return {
    name: `${slug}__list_spaces`,
    cleanup: () => deleteFixture(cloud, `/api/admin/connector-apps/${app.id}`),
  }
}

async function assertConnectorCallable(mcp, name) {
  const result = await mcp.request('tools/call', { name, arguments: {} })
  assert.equal(result.isError, false, 'The real MCP child could not call the real Backend')
  const text = result.content
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n')
  assert.ok(Array.isArray(JSON.parse(text)), 'The real project-space tool did not return a list')
}

function connectorRuntime(control, cloud, request, resultDir, timeoutMs) {
  const rpc = (method, params) => requestExecutor(control, method, params, timeoutMs)
  let syncRevision = 0
  const configure = async (connectorToken, expiresAtMs) => {
    syncRevision = Math.max(syncRevision + 1, Date.now() * 1_000)
    const configured = await rpc('runtime.connectors.configure', {
      apiBaseUrl: `${cloud.backendUrl}/api`,
      connectorToken,
      expiresAtMs,
      syncRevision,
    })
    assert.equal(configured.configured, true)
    assert.notEqual(configured.stale, true, 'The connector refresh was discarded as stale')
  }
  const refresh = connectorRefresh(rpc, request, configure)
  const readConfig = () =>
    rpc('runtime.codex.app_server.request', {
      method: 'config/read',
      params: { includeLayers: false },
    })
  const processStarts = async () => {
    const log = await readFile(join(resultDir, 'executor.log'), 'utf8')
    return [...log.matchAll(/codex shared app-server process starting process_id=(\d+)/g)].map(
      match => match[1]
    )
  }
  return { rpc, configure, refresh, readConfig, processStarts }
}

async function shortLivedConnectorToken(cloud, request, timeoutMs) {
  const issued = await request('/api/connector-runtime/token', { method: 'POST' })
  const [header, payload] = issued.access_token.split('.')
  assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')).alg, 'HS256')
  assert.ok(cloud.backendEnv.SECRET_KEY, 'The isolated Backend signing key is unavailable')
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  // Preserve the real issuer's claims, shortening only the isolated fixture's lifetime.
  claims.exp = Math.ceil((Date.now() + 5 * timeoutMs + 5_000) / 1_000)
  const unsigned = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`
  const signature = createHmac('sha256', cloud.backendEnv.SECRET_KEY)
    .update(unsigned)
    .digest('base64url')
  return { token: `${unsigned}.${signature}`, expiresAtMs: claims.exp * 1_000 }
}

async function assertConnectorTokenExpired(cloud, authorization, name, timeoutMs) {
  await until(
    () => Date.now(),
    now => now >= authorization.expiresAtMs + 1_000,
    'The original connector JWT did not reach its expiration time',
    Math.max(timeoutMs, authorization.expiresAtMs - Date.now() + timeoutMs)
  )
  const response = await fetch(`${cloud.backendUrl}/api/connector-runtime/call`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authorization.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, arguments: {} }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  await response.arrayBuffer()
  assert.equal(response.status, 401, 'The real Backend still accepts the original expired JWT')
}

async function verifyUnchangedConnectorRefresh(control, cloud, request, options) {
  const { executorBinary, environment, resultDir } = options
  const timeoutMs = Math.min(options.timeoutMs, 10_000)
  const { configure, refresh, readConfig, processStarts } = connectorRuntime(
    control,
    cloud,
    request,
    resultDir,
    timeoutMs
  )
  const connector = await createCallableConnector(cloud, request)
  try {
    await refresh()
    await readConfig()
    const starts = await processStarts()
    assert.ok(starts.length > 0, 'The connector fixture did not start the real Codex app-server')
    const originalAuthorization = await shortLivedConnectorToken(cloud, request, timeoutMs)
    await configure(originalAuthorization.token, originalAuthorization.expiresAtMs)
    await withConnectorMcp({ binary: executorBinary, environment, timeoutMs }, async mcp => {
      const pid = mcp.pid
      const catalog = await mcp.request('tools/list')
      assert.ok(
        catalog.tools.some(tool => tool.name === connector.name),
        'The renewal tool was not discovered through the real MCP child'
      )
      await assertConnectorCallable(mcp, connector.name)
      // Keep one MCP child alive and cross the original JWT's real Backend expiry.
      for (let cycle = 0; cycle < 2; cycle += 1) {
        const result = await refresh()
        assert.equal(result.changed, false, 'An unchanged connector refresh changed capabilities')
        await readConfig()
        if (cycle === 0) {
          await assertConnectorTokenExpired(cloud, originalAuthorization, connector.name, timeoutMs)
        }
        // Call directly: another tools/list must not be needed to reload authorization.
        await assertConnectorCallable(mcp, connector.name)
        mcp.assertRunning()
        assert.equal(mcp.pid, pid, 'Connector renewal replaced the real MCP child')
        assert.deepEqual(await processStarts(), starts, 'Connector renewal restarted idle Codex')
      }
    })
  } finally {
    await connector.cleanup()
    await refresh()
  }
}

async function createKnowledgeCredentials(cloud, request, workspacePath, cleanups) {
  const bot = await request('/api/bots', {
    method: 'POST',
    body: JSON.stringify({
      name: `Connector definition bot ${process.pid}`,
      shell_name: 'Codex',
      agent_config: { bind_model: CLOUD_PUBLIC_MODEL_NAME, bind_model_type: 'public' },
    }),
  })
  cleanups.push(() => request(`/api/bots/${bot.id}`, { method: 'DELETE' }))
  const team = await request('/api/teams', {
    method: 'POST',
    body: JSON.stringify({
      name: `connector-definition-team-${process.pid}`,
      namespace: 'default',
      collaboration_model: 'pipeline',
      bots: [{ bot_id: bot.id }],
    }),
  })
  cleanups.push(() =>
    request(`/api/teams/${team.id}?force=true&confirm_name=${encodeURIComponent(team.name)}`, {
      method: 'DELETE',
    })
  )
  const device = await cloud.waitForConnectedAppDevice()
  // Materialization mints a real task token without dispatching or persisting a Task.
  const materialized = await request('/api/runtime-work/materialize', {
    method: 'POST',
    body: JSON.stringify({
      schemaVersion: 3,
      wegentTeamId: team.id,
      deviceId: device.device_id,
      workspacePath,
      runtime: 'codex',
      message: 'Materialize an isolated connector definition fixture',
    }),
  })
  const apiKey = await request('/api/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name: `Connector definition ${process.pid}` }),
  })
  cleanups.push(() => deleteFixture(cloud, `/api/api-keys/${apiKey.id}`))
  const taskToken = materialized.payload.executionRequest.auth_token
  assert.ok(taskToken, 'Materialization did not return a task token')
  assert.ok(apiKey.key, 'The isolated personal API key was not created')
  return { taskToken, apiKey: apiKey.key }
}

async function connectorDefinition(rpc, name) {
  const catalog = await rpc('runtime.connectors.tools', {})
  const tool = catalog.tools.find(candidate => candidate.name === name)
  assert.ok(tool, 'The real knowledge connector was not discovered')
  return tool
}

async function connectorMarker(result, slug) {
  const app = result.apps.find(candidate => candidate.slug === slug)
  assert.ok(app, 'The connector definition was not materialized for Codex')
  return readFile(join(dirname(app.skillPath), '.wegent-connector'), 'utf8')
}

async function createKnowledgeConnector(cloud, request, taskToken, refresh, cleanups) {
  const slug = `definition-knowledge-${process.pid}`
  const app = await request('/api/admin/connector-apps', {
    method: 'POST',
    body: JSON.stringify({
      slug,
      name: 'Connector definition knowledge',
      auth_type: 'none',
      transport: 'streamable-http',
      mcp_url: `${cloud.backendUrl}/api/mcp/knowledge/sse`,
      provider_headers: { Authorization: `Bearer ${taskToken}` },
      tool_allowlist: ['wegent_kb_list_knowledge_bases'],
    }),
  })
  cleanups.push(async () => {
    await deleteFixture(cloud, `/api/admin/connector-apps/${app.id}`)
    await refresh()
  })
  return { id: app.id, slug, name: `${slug}__wegent_kb_list_knowledge_bases` }
}

async function verifyConnectorDefinitionUpdate(runtime, cloud, request, workspacePath) {
  const { rpc, refresh, readConfig, processStarts } = runtime
  const cleanups = []
  try {
    const credentials = await createKnowledgeCredentials(cloud, request, workspacePath, cleanups)
    const app = await createKnowledgeConnector(
      cloud,
      request,
      credentials.taskToken,
      refresh,
      cleanups
    )
    const initial = await refresh()
    const before = await connectorDefinition(rpc, app.name)
    const oldMarker = await connectorMarker(initial, app.slug)
    assert.equal(before.input_schema.properties.query, undefined)
    assert.equal(before.input_schema.properties.owner_user_ids, undefined)
    await readConfig()
    const starts = await processStarts()
    assert.ok(starts.length > 0, 'The definition fixture did not start real Codex')

    // These real Backend MCPs expose the same name with different descriptions and schemas.
    await request(`/api/admin/connector-apps/${app.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        mcp_url: `${cloud.backendUrl}/api/mcp/knowledge-external/sse`,
        provider_headers: { Authorization: `Bearer ${credentials.apiKey}` },
      }),
    })
    const updated = await refresh()
    assert.equal(updated.changed, true, 'A same-name tool definition update was ignored')
    await readConfig()
    const updatedStarts = await processStarts()
    assert.equal(
      updatedStarts.length,
      starts.length + 1,
      'Codex did not reload changed definitions'
    )
    assert.notEqual(updatedStarts.at(-1), starts.at(-1), 'The Codex process ID did not change')
    const after = await connectorDefinition(rpc, app.name)
    assert.equal(after.name, before.name)
    assert.notEqual(after.description, before.description)
    assert.notDeepEqual(after.input_schema, before.input_schema)
    assert.ok(after.input_schema.properties.query, 'The new query schema was not projected')
    assert.ok(
      after.input_schema.properties.owner_user_ids,
      'The new owner schema was not projected'
    )
    const updatedMarker = await connectorMarker(updated, app.slug)
    assert.notEqual(updatedMarker, oldMarker)

    const repeated = await refresh()
    assert.equal(repeated.changed, false, 'The updated definition was not idempotent')
    await readConfig()
    assert.deepEqual(
      await processStarts(),
      updatedStarts,
      'An unchanged definition restarted Codex'
    )
    assert.equal(await connectorMarker(repeated, app.slug), updatedMarker)
  } finally {
    await cleanupFixtures(cleanups)
  }
}

async function assertPluginSyncCompletion(resultDir, generation, changed, timeoutMs, logOffset) {
  const completion = await until(
    async () => {
      const log = await readFile(join(resultDir, 'executor.log'), 'utf8')
      return log
        .slice(logOffset)
        .split('\n')
        .filter(
          line =>
            line.includes('plugin_sync_completed ') && line.includes(` generation=${generation} `)
        )
        .at(-1)
    },
    Boolean,
    'The real full capability snapshot did not finish',
    timeoutMs
  )
  assert.match(completion, new RegExp(`\\bchanged=${changed}\\b`))
}

async function assertPluginSkill(
  runtime,
  executorHome,
  workspacePath,
  fixture,
  version,
  description
) {
  const root = await managedRoot(executorHome, fixture.installedId)
  assert.ok(root, 'The real plugin runtime was not materialized')
  const metadata = JSON.parse(await readFile(join(root, '.codex-plugin/plugin.json'), 'utf8'))
  assert.equal(metadata.version, version, 'The plugin runtime has the wrong release')
  const skillPath = join(root, 'skills', fixture.skillName, 'SKILL.md')
  const content = await readFile(skillPath, 'utf8')
  assert.ok(content.includes(description), 'The plugin skill file has a stale definition')
  const catalog = await runtime.rpc('runtime.codex.app_server.request', {
    method: 'skills/list',
    params: { cwds: [workspacePath], forceReload: true },
  })
  const skill = catalog.data
    .flatMap(entry => entry.skills)
    .find(skill => skill.name === `${fixture.pluginName}:${fixture.skillName}`)
  assert.ok(skill, 'Real Codex did not discover the installed plugin skill')
  assert.equal(typeof skill.path, 'string', 'Real Codex did not return the skill file path')
  assert.equal(
    await realpath(skill.path),
    await realpath(skillPath),
    'Real Codex loaded the skill from an outdated plugin runtime'
  )
  assert.equal(
    skill.description,
    description,
    'Real Codex did not load the current skill definition'
  )
}

async function syncFullCapabilities(request, deviceId, resultDir, timeoutMs) {
  const logOffset = (await readFile(join(resultDir, 'executor.log'), 'utf8')).length
  const synchronized = await request(
    `/api/plugins/installed/sync-device?device_id=${encodeURIComponent(deviceId)}`,
    { method: 'POST' }
  )
  const result = synchronized.sync.results.find(result => result.device_id === deviceId)
  assert.ok(result, 'The real device did not acknowledge the complete capability snapshot')
  assert.equal(result.success, true)
  assert.equal(result.scope, 'all')
  assert.equal(result.plugin_sync.version, 2)
  assert.equal(result.plugin_sync.complete, true)
  await assertPluginSyncCompletion(
    resultDir,
    result.plugin_sync.generation,
    false,
    timeoutMs,
    logOffset
  )
  return result.plugin_sync.generation
}

async function verifyPluginFullSync(runtime, cloud, request, options) {
  const { executorHome, workspacePath, resultDir, timeoutMs } = options
  const device = await cloud.waitForConnectedAppDevice()
  const deviceQuery = `device_id=${encodeURIComponent(device.device_id)}`
  const slug = `full-sync-plugin-${process.pid}`
  const skillName = `${slug}-check`
  const originalDescription = 'Original cloud full-sync skill definition'
  const updatedDescription = 'Updated cloud full-sync skill definition'
  const cleanups = []
  let backendStopped = false
  try {
    const release = await cloud.publishPluginRelease({
      slug,
      version: '1.0.0',
      skills: { [skillName]: originalDescription },
    })
    const installation = await request(
      `/api/plugins/marketplace/${release.pluginId}/install?${deviceQuery}`,
      { method: 'POST' }
    )
    const fixture = {
      installedId: Number(installation.plugin.metadata.labels.id),
      pluginName: slug,
      skillName,
    }
    assert.ok(Number.isSafeInteger(fixture.installedId) && fixture.installedId > 0)
    cleanups.push(async () => {
      await deleteFixture(cloud, `/api/plugins/installed/${fixture.installedId}?${deviceQuery}`)
      const removed = await request(`/api/plugins/installed/sync-device?${deviceQuery}`, {
        method: 'POST',
      })
      assert.equal(removed.sync.success, true, 'The real plugin cleanup was not synchronized')
      const manifest = await readCapabilityManifest(executorHome)
      assert.ok(
        !Object.values(manifest.plugins ?? {}).some(
          plugin => Number(plugin.installed_plugin_id) === fixture.installedId
        ),
        'The isolated plugin fixture remained in the runtime after cleanup'
      )
    })
    await request(`/api/plugins/installed/${fixture.installedId}?${deviceQuery}`, {
      method: 'PUT',
      body: JSON.stringify({ updatePolicy: 'manual' }),
    })
    await assertPluginSkill(
      runtime,
      executorHome,
      workspacePath,
      fixture,
      '1.0.0',
      originalDescription
    )
    const starts = await runtime.processStarts()
    assert.ok(starts.length > 0, 'The plugin fixture did not start real Codex')

    let generation = (await readCapabilityManifest(executorHome)).plugin_sync.full_generation
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const nextGeneration = await syncFullCapabilities(
        request,
        device.device_id,
        resultDir,
        timeoutMs
      )
      assert.ok(nextGeneration > generation, 'The full snapshot generation did not advance')
      generation = nextGeneration
      await runtime.readConfig()
      assert.deepEqual(await runtime.processStarts(), starts, 'Identical full sync restarted Codex')
    }

    const reconnectLogOffset = (await readFile(join(resultDir, 'executor.log'), 'utf8')).length
    const beforeReconnect = (await readCapabilityManifest(executorHome)).plugin_sync.full_generation
    backendStopped = true
    await cloud.stopBackend()
    await cloud.launchBackend()
    backendStopped = false
    await cloud.waitForConnectedAppDevice()
    const reconnected = await until(
      () => readCapabilityManifest(executorHome),
      manifest => manifest.plugin_sync?.full_generation > beforeReconnect,
      'Device reconnection did not apply its real full capability snapshot',
      timeoutMs
    )
    await assertPluginSyncCompletion(
      resultDir,
      reconnected.plugin_sync.full_generation,
      false,
      timeoutMs,
      reconnectLogOffset
    )
    // A newer acknowledged full snapshot fences registration snapshots that were still queued.
    const settledGeneration = await syncFullCapabilities(
      request,
      device.device_id,
      resultDir,
      timeoutMs
    )
    assert.ok(settledGeneration > reconnected.plugin_sync.full_generation)
    const reconnectLog = (await readFile(join(resultDir, 'executor.log'), 'utf8')).slice(
      reconnectLogOffset
    )
    const completions = reconnectLog
      .split('\n')
      .filter(line => line.includes('plugin_sync_completed '))
    assert.ok(completions.length >= 2, 'Registration and its full-sync barrier did not complete')
    for (const completion of completions) {
      assert.match(completion, /\bchanged=false\b/, 'A reconnect snapshot changed capabilities')
    }
    await runtime.readConfig()
    assert.deepEqual(await runtime.processStarts(), starts, 'Backend reconnection restarted Codex')

    const updated = await cloud.publishPluginRelease({
      slug,
      version: '2.0.0',
      skills: { [skillName]: updatedDescription },
    })
    await request(`/api/plugins/installed/${fixture.installedId}?${deviceQuery}`, {
      method: 'PUT',
      body: JSON.stringify({ releaseId: updated.releaseId }),
    })
    await assertPluginSkill(
      runtime,
      executorHome,
      workspacePath,
      fixture,
      '2.0.0',
      updatedDescription
    )
    const updatedStarts = await runtime.processStarts()
    assert.equal(updatedStarts.length, starts.length + 1, 'The new skill did not reload Codex once')
    assert.notEqual(
      updatedStarts.at(-1),
      starts.at(-1),
      'The upgraded Codex process ID did not change'
    )
    await syncFullCapabilities(request, device.device_id, resultDir, timeoutMs)
    await runtime.readConfig()
    assert.deepEqual(
      await runtime.processStarts(),
      updatedStarts,
      'Repeated upgrade sync restarted Codex'
    )
  } finally {
    if (backendStopped) await cloud.launchBackend()
    await cleanupFixtures(cleanups)
  }
}

export function createDesktopScenario({ executorHome, resultDir, uiTimeoutMs, workspacePath }) {
  let cloudEnvironment
  let executorBinary
  let environment
  const request = (path, options = {}) =>
    fetchJson(`${cloudEnvironment.backendUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${cloudEnvironment.authToken}`,
        'Content-Type': 'application/json',
      },
    })

  return {
    requiresCloudEnvironment: true,
    backendEnv: { EXTERNAL_KNOWLEDGE_MCP_ENABLED: 'true' },
    setExecutorBinary(binary) {
      executorBinary = binary
    },
    async prepareApp({ appEnvironment }) {
      environment = { ...appEnvironment }
      assert.equal(environment.WEGENT_EXECUTOR_HOME, executorHome)
    },
    async prepareCloud(cloud) {
      cloudEnvironment = cloud
      await request('/api/admin/setup-complete', { method: 'POST' })
      const externalKnowledge = await request('/api/mcp/knowledge-external/health')
      assert.equal(externalKnowledge.status, 'healthy')
      assert.equal(externalKnowledge.service, 'wegent-knowledge-external-mcp')
    },
    setCloudEnvironment(cloud) {
      cloudEnvironment = cloud
    },
    async verify(control) {
      await verifyCloudModelRecovery(control, cloudEnvironment, request)
      await verifyUnchangedConnectorRefresh(control, cloudEnvironment, request, {
        executorBinary,
        environment,
        resultDir,
        timeoutMs: uiTimeoutMs,
      })
      await verifyConnectorDefinitionUpdate(
        connectorRuntime(control, cloudEnvironment, request, resultDir, uiTimeoutMs),
        cloudEnvironment,
        request,
        workspacePath
      )
      await verifyPluginFullSync(
        connectorRuntime(control, cloudEnvironment, request, resultDir, uiTimeoutMs),
        cloudEnvironment,
        request,
        { executorHome, workspacePath, resultDir, timeoutMs: uiTimeoutMs }
      )
    },
  }
}
