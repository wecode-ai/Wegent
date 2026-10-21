import assert from 'node:assert/strict'
import {
  createLocalCollaborationProject,
  openProjectAgentCreator,
  selectAgentEnvironment,
  selectAgentFormTab,
  selectCollaborationProjectView,
  waitForTestIdByText,
} from './workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${CONTENT} ${selector}`
const NATIVE_CATALOG_PATH = '/api/v1/resources/execution-environments'

export function assertNativeCatalogRequests(entries, beforeDeviceSelection = false) {
  const catalogs = entries.filter(entry => entry.path === NATIVE_CATALOG_PATH)
  assert.equal(
    catalogs.filter(entry => entry.unscoped).length,
    0,
    'Creation scanned an unscoped native catalog'
  )
  if (beforeDeviceSelection) {
    assert.equal(catalogs.length, 0, 'Native discovery started before selecting a device')
  }
}

export const nativeCatalogFault = (entry, fault) =>
  entry.method === 'GET' && entry.path === NATIVE_CATALOG_PATH && !entry.unscoped ? fault : null

export const hasScopedNativeFault = (entries, fault) =>
  entries.some(
    entry =>
      entry.method === 'GET' &&
      entry.path === NATIVE_CATALOG_PATH &&
      !entry.unscoped &&
      entry.fault === fault &&
      entry.status === 200 &&
      (fault !== 'hold-response' || entry.committedResponseHeld)
  )

/** Inspect the default without ever activating runtime settings. */
export async function readBasicCloudDefault(control, prefix, dialogId, timeoutMs) {
  await control.command('waitFor', `[data-testid="${dialogId}-tab-basic"][aria-selected="true"]`, {
    timeoutMs,
  })
  const options = `[data-testid="${prefix}-model"] option:not([value=""]):not([value="user_select"]):not(:disabled)`
  await control.command('waitFor', `${options}:checked`, { timeoutMs })
  const value = await control.command('getAttribute', `${options}:checked`, { value: 'value' })
  assert.equal(value, await control.command('getAttribute', options, { value: 'value' }))
  const identity = JSON.parse(value)
  assert.equal(identity[1], 'cloud', 'Creation must default to the first cloud model')
  return {
    value,
    runtime: identity[0],
    reference: {
      type: identity[2],
      namespace: identity[3],
      resource_user_id: identity[4],
      name: identity[5],
    },
  }
}

export async function assertSavedCloudRouting(request, agent, model, executionPolicy) {
  assert.ok(agent.wegentTeamId, 'The saved Agent has no Team binding')
  const team = await request(`/api/teams/${agent.wegentTeamId}`)
  const bot = team.bots.find(entry => entry.role === 'leader')?.bot ?? team.bots[0]?.bot
  assert.ok(bot, 'The saved Team has no Bot')
  assert.deepEqual(bot.execution_policy, {
    mode: executionPolicy.mode,
    environment_id: executionPolicy.mode === 'fixed' ? executionPolicy.environment_id : null,
  })
  assert.equal(bot.model_policy.mode, 'fixed')
  assert.equal(bot.model_policy.model.source, 'cloud')
  assert.equal(bot.model_policy.model.runtime, model.runtime)
  assert.deepEqual(bot.model_policy.model.cloud_model, model.reference)
}

/** These transport faults still forward to the real Backend; no catalog is fabricated. */
export async function verifyCloudSaveDuringNativeFaults(
  control,
  { projectId, device, request, proxy, waitForApiValue, timeoutMs }
) {
  await control.command('click', scoped('[data-testid="collaboration-project-settings-agents"]'))
  for (const fault of ['drop-response', 'hold-response']) {
    const name = `Cloud model with ${fault}-${process.pid}`
    proxy.rule = entry => nativeCatalogFault(entry, fault)
    const start = proxy.requests.length
    try {
      await openProjectAgentCreator(
        control,
        scoped('[data-testid="project-agent-add"]'),
        timeoutMs,
        'wework-agent-resource-creator'
      )
      await control.command('fill', '[data-testid="wework-agent-display-name"]', { value: name })
      const model = await readBasicCloudDefault(
        control,
        'wework-agent',
        'wework-agent-resource-creator',
        timeoutMs
      )
      assertNativeCatalogRequests(proxy.requests.slice(start), true)
      await selectAgentFormTab(control, 'wework-agent-resource-creator', 'runtime', timeoutMs)
      assertNativeCatalogRequests(proxy.requests.slice(start), true)
      await selectAgentEnvironment(
        control,
        'wework-agent-environment',
        String(device.id),
        timeoutMs,
        false,
        () => assertNativeCatalogRequests(proxy.requests.slice(start), true)
      )
      await waitForApiValue(
        async () => proxy.requests.slice(start),
        entries => hasScopedNativeFault(entries, fault),
        'The real native model catalog did not reach the fault proxy',
        timeoutMs
      )
      if (fault === 'drop-response') {
        await control.command(
          'waitFor',
          '[data-testid="wework-agent-resource-creator"] [role="alert"]',
          { timeoutMs }
        )
      }
      assert.equal(
        await control.command('getValue', '[data-testid="wework-agent-model"]'),
        model.value
      )
      await control.command('clickWhenEnabled', '[data-testid="wework-agent-resource-create"]', {
        timeoutMs,
      })
      await control.command('waitFor', '[data-testid="wework-agent-resource-creator"]', {
        visible: false,
        timeoutMs,
      })
      const agent = await waitForApiValue(
        () => request(`/api/v1/cloud-projects/${projectId}/chat-agents`),
        agents => agents.find(candidate => candidate.name === name),
        'Saving a cloud model during native discovery failure did not persist',
        timeoutMs
      )
      await assertSavedCloudRouting(request, agent, model, {
        mode: 'fixed',
        environment_id: String(device.id),
      })
      assertNativeCatalogRequests(proxy.requests.slice(start))
    } finally {
      proxy.rule = () => null
    }
  }
}

/** Reopening reads the saved local Agent through the real executor API. */
export async function verifyLocalBasicDefaultSave(control, timeoutMs, proxy) {
  const start = proxy.requests.length
  await createLocalCollaborationProject(control, CONTENT, `Default cloud model-${process.pid}`)
  await selectCollaborationProjectView(control, CONTENT, 'manage')
  await control.command('click', scoped('[data-testid="collaboration-project-settings-agents"]'))
  await openProjectAgentCreator(control, scoped('[data-testid="project-agent-add"]'), timeoutMs)
  const name = `Local default model-${process.pid}`
  await control.command('fill', '[data-testid="cloud-project-chat-agent-display-name"]', {
    value: name,
  })
  const model = await readBasicCloudDefault(
    control,
    'cloud-project-chat-agent',
    'cloud-project-chat-agent-editor',
    timeoutMs
  )
  assertNativeCatalogRequests(proxy.requests.slice(start), true)
  await control.command('clickWhenEnabled', '[data-testid="cloud-project-chat-agent-save"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="cloud-project-chat-agent-editor"]', {
    visible: false,
    timeoutMs,
  })
  const row = await waitForTestIdByText(
    control,
    scoped('[data-testid="project-agent-list"]'),
    'project-agent-row-',
    name,
    timeoutMs
  )
  const agentId = row.slice('project-agent-row-'.length)
  // Unmount the project settings before reading the persisted Agent again.
  await selectCollaborationProjectView(control, CONTENT, 'board')
  await selectCollaborationProjectView(control, CONTENT, 'manage')
  await control.command('click', scoped('[data-testid="collaboration-project-settings-agents"]'))
  await control.command(
    'clickWhenEnabled',
    scoped(`[data-testid="project-agent-edit-${agentId}"]`),
    { timeoutMs }
  )
  await selectAgentFormTab(control, 'cloud-project-chat-agent-editor', 'runtime', timeoutMs)
  await control.command(
    'waitFor',
    '[data-testid="cloud-project-chat-agent-environment"][data-value="policy:project_pool"]',
    { timeoutMs }
  )
  await control.command(
    'waitFor',
    `[data-testid="cloud-project-chat-agent-model"] option[value='${model.value}']:checked`,
    { timeoutMs }
  )
  await control.command('click', '[data-testid="cloud-project-chat-agent-cancel"]')
  assertNativeCatalogRequests(proxy.requests.slice(start), true)
}
