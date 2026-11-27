import assert from 'node:assert/strict'
import { TransportFaultProxy } from './transport-fault-proxy.mjs'

/** Preserve the actual cloud response envelope and authentication used by this scenario. */
export function createCollaborationExpCloudRequest(cloud, timeoutMs) {
  return async (path, body, options = {}) => {
    const response = await fetch(cloud.backendUrl + path, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        Authorization: 'Bearer ' + (options.token ?? cloud.authToken),
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    assert.ok(response.ok, path + ': ' + response.status + ' ' + text)
    return text ? JSON.parse(text) : null
  }
}

/** Pause only the first account loads; forward their real replies after native role preparation. */
export async function pauseCollaborationExpAccountReads(cloud) {
  const proxy = new TransportFaultProxy(cloud.backendUrl)
  proxy.rule = entry =>
    entry.method === 'GET' && entry.path === '/api/v1/personal-assistant' ? 'pause-request' : null
  await proxy.start()
  return {
    backendUrl: proxy.url,
    proxy,
    async prepareNative(control, prepareRole) {
      try {
        await prepareRole(control)
      } catch (error) {
        await proxy.stop()
        throw error
      }
    },
    release() {
      proxy.rule = () => null
      for (const request of [...proxy.pausedRequests]) request.release()
    },
    cleanup: () => proxy.stop(),
  }
}

/** Complete real account onboarding before testing management of a native-only team. */
export async function migrateCollaborationExpAssistant({
  control,
  request,
  settings,
  returnRoute,
  nativeTaskIdentities,
  localIssueIdentities,
}) {
  const tasks = await nativeTaskIdentities()
  const issues = await localIssueIdentities()
  assert.equal((await request('/api/v1/personal-assistant')).assistant, null)
  await control.command('navigate', 'body', { value: '/stand-in' })
  const confirm = '[data-testid="personal-assistant-account-migrate-confirm"]'
  await control.command('waitFor', confirm, { visible: true })
  await control.command('clickWhenEnabled', confirm)
  await control.command('waitFor', '[data-testid="personal-assistant-account-setup"]', {
    visible: false,
  })
  await control.command('waitFor', '[data-testid="stand-in-overview"]', { visible: true })
  const { assistant } = await request('/api/v1/personal-assistant')
  assertCollaborationExpMigratedAccount(assistant, settings)
  assert.deepEqual(
    await nativeTaskIdentities(),
    tasks,
    'Cloud migration must preserve native task identities'
  )
  assert.deepEqual(
    await localIssueIdentities(),
    issues,
    'Cloud migration must preserve local Issue identities'
  )
  await control.command('navigate', 'body', { value: returnRoute })
}

export function assertCollaborationExpMigratedAccount(assistant, settings) {
  assert.ok(assistant, 'The confirmed migration must initialize the real cloud account')
  assert.deepEqual(
    assistant.definitions.map(definition => definition.roleId).sort(),
    ['@primary', ...settings.roles.map(role => role.id)].sort(),
    'Cloud migration must preserve every native role ID'
  )
  for (const role of settings.roles) {
    const definition = assistant.definitions.find(definition => definition.roleId === role.id)
    assert.deepEqual(
      {
        name: definition.bot.metadata.displayName,
        prompt: definition.ghost.spec.systemPrompt,
        device: definition.bot.spec.execution_policy,
      },
      {
        name: role.name,
        prompt: role.prompt,
        device: { mode: 'fixed', environment_id: role.executionDeviceId },
      },
      'Cloud migration must preserve the role definition'
    )
  }
  const primary = assistant.definitions.find(definition => definition.roleId === '@primary')
  assert.deepEqual(assistant.defaultBotRef, {
    name: primary.bot.metadata.name,
    namespace: primary.bot.metadata.namespace,
  })
  assert.equal(primary.ghost.spec.systemPrompt, settings.primary?.prompt ?? '')
  assert.deepEqual(primary.bot.spec.execution_policy, {
    mode: 'fixed',
    environment_id: settings.executionDeviceId,
  })
}
