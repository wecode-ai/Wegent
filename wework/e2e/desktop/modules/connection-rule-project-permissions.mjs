import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { TransportFaultProxy } from './transport-fault-proxy.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'
import { openProjectBoard } from './collaboration-board-personal-view.mjs'
import { waitForElementInsideScroller } from './conversation-layout.mjs'

export async function permissionRequest(
  environment,
  path,
  { method = 'GET', body, token = environment.authToken, status } = {}
) {
  const response = await fetch(`${environment.backendUrl}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  })
  if (status) assert.equal(response.status, status, `${method} ${path}`)
  else assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`)
  return response.status === 204 ? null : response.json()
}

export async function verifyConnectionRuleProjectPermissions(
  control,
  environment,
  projectId,
  restart,
  options
) {
  assert.ok(restart, 'Project permission verification requires the shared Electron restart hook')
  const request = (path, init) => permissionRequest(environment, path, init)
  const rpc = (method, params) => requestExecutor(control, method, params, options.uiTimeoutMs)
  const username = `source-permissions-${process.pid}`
  const member = await request('/admin/users', {
    method: 'POST',
    body: {
      user_name: username,
      password: `${username}-password`,
      role: 'user',
      auth_source: 'password',
    },
  })
  const login = await request('/auth/login', {
    method: 'POST',
    body: { user_name: username, password: `${username}-password` },
  })
  const memberPath = `/v1/cloud-projects/${projectId}/members/${member.id}`
  await request(`/v1/cloud-projects/${projectId}/members`, {
    method: 'POST',
    body: { user_id: member.id, role: 'Maintainer' },
  })
  const proxy = await new TransportFaultProxy(environment.backendUrl).start()
  let switched = false
  let localProject
  let cloudRule
  let uiRule
  let failure
  let originalWindowSize
  try {
    await restart({
      appEnvironmentOverrides: {
        WEWORK_E2E_CLOUD_TOKEN: login.access_token,
        WEWORK_E2E_CLOUD_BACKEND_URL: proxy.url,
      },
    })
    switched = true
    await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
      timeoutMs: options.workbenchReadyTimeoutMs,
    })
    const deadline = Date.now() + options.workbenchReadyTimeoutMs
    while (!(await rpc('executor.backend.status', {})).configured) {
      assert.ok(Date.now() < deadline, 'The real member connection did not become ready')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const providerId = '@test/connection-automation/records'
    const source = (
      await rpc('runtime.connections.resources', { providerId, kind: 'record', query: '' })
    ).items[0]
    assert.ok(source, 'The real source provider was not available after account switching')
    const save = rule => rpc('runtime.connection_rules.save', { userId: member.id, rule })
    const base = {
      version: 0,
      name: 'Project permission boundary',
      enabled: true,
      source,
      eventType: 'record.received',
      targetKind: 'human',
      targetId: String(member.id),
      publication: { title: 'Authorized result', instruction: 'Publish an anonymized result only' },
    }
    cloudRule = (
      await save({
        ...base,
        id: 'permission-cloud-rule',
        project: { id: String(projectId), store: 'cloud' },
      })
    ).rule
    uiRule = (
      await save({
        ...base,
        id: 'permission-ui-rule',
        name: 'My private source',
        project: { id: String(projectId), store: 'cloud' },
      })
    ).rule
    localProject = await rpc('projects.create', { name: 'Private rules after project refusal' })
    const localRule = (
      await save({
        ...base,
        id: 'permission-local-rule',
        project: { id: localProject.id, store: 'local' },
      })
    ).rule
    await request(memberPath, { method: 'PATCH', body: { role: 'Viewer' } })
    await request('/users/me', { token: login.access_token, status: 200 })
    await request(`/v1/cloud-projects/${projectId}/incoming-hooks`, {
      token: login.access_token,
      status: 403,
    })
    const content = '[data-testid="workspace-tab-content-fixed-board"]'
    await reloadMainWindow(control, 'The Viewer role did not reconnect after reload')
    originalWindowSize = await control.command('setMainWindowSize', 'body', {
      value: JSON.stringify({ width: 1280, height: 720 }),
    })
    const project = await request(`/v1/cloud-projects/${projectId}`)
    await openProjectBoard(control, selector => `${content} ${selector}`, project)
    console.log('[source-rule-permissions] Viewer project opened through the project picker')
    await waitForElementInsideScroller(
      control,
      `${content} [data-testid="private-connection-rules-open"]`,
      content,
      'Private source rule entry must fit the compact project header',
      options.uiTimeoutMs,
      { clipToViewport: true }
    )
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          `${content} [data-testid="cloud-project-manage-view"]`
        )
      ),
      0
    )
    await options.captureScreenshot(control, 'connection-permissions-00-viewer-entry.png', content)
    await control.command(
      'clickWhenEnabled',
      `${content} [data-testid="private-connection-rules-open"]`
    )
    await control.command('waitFor', `${content} [data-testid="connection-rules-project-readonly"]`)
    await waitForElementInsideScroller(
      control,
      `${content} [role="dialog"]`,
      'body',
      'Private source dialog must fit the compact window',
      options.uiTimeoutMs,
      { clipToViewport: true }
    )
    await waitForElementInsideScroller(
      control,
      `${content} [data-testid="private-connection-rules-close"]`,
      `${content} [role="dialog"]`,
      'Private source dialog close must remain visible',
      options.uiTimeoutMs,
      { clipToViewport: true }
    )
    for (const testId of ['connection-rule-create', `connection-rule-toggle-${uiRule.id}`]) {
      assert.equal(
        Number(await control.command('getElementCount', `${content} [data-testid="${testId}"]`)),
        0
      )
    }
    await control.command(
      'waitFor',
      `${content} [data-testid="connection-rule-remove-${uiRule.id}"]`
    )
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          `${content} [data-testid="connection-rule-edit-${uiRule.id}"]:disabled`
        )
      ),
      1
    )
    await options.captureScreenshot(
      control,
      'connection-permissions-01-viewer-private-rule.png',
      content
    )
    // Hold identity verification unavailable before the denial, so a new login check
    // cannot hide incorrectly discarded device evidence between assertions.
    proxy.rule = entry => (entry.path === '/api/users/me' ? 'drop-response' : null)
    await assert.rejects(
      () => save({ ...cloudRule, enabled: false }),
      /Project authorization was denied/
    )
    const ownLocal = (
      await rpc('runtime.connection_rules.list', { userId: member.id, project: localRule.project })
    ).items
    assert.equal(ownLocal.length, 1, 'A project refusal removed access to unrelated private rules')
    const paused = (await save({ ...ownLocal[0], enabled: false })).rule
    assert.equal(paused.enabled, false)
    await rpc('runtime.connection_rules.remove', {
      userId: member.id,
      id: cloudRule.id,
      version: cloudRule.version,
    })
    const remaining = (await rpc('runtime.connection_rules.list', { userId: member.id })).items
    assert.equal(
      remaining.some(rule => rule.id === cloudRule.id),
      false
    )
    assert.equal(remaining.find(rule => rule.id === localRule.id)?.enabled, false)
    assert.ok(
      (await request(`/v1/cloud-projects/${projectId}/automations`)).some(
        rule => rule.id === cloudRule.cloudRuleId
      ),
      'Private cleanup bypassed project write authorization'
    )
    await control.command(
      'clickWhenEnabled',
      `${content} [data-testid="connection-rule-history-${uiRule.id}"]`
    )
    await control.command('waitFor', `${content} [data-testid="connection-rule-runs"]`)
    await control.command(
      'clickWhenEnabled',
      `${content} [data-testid="connection-rule-remove-${uiRule.id}"]`
    )
    await control.command(
      'waitFor',
      `${content} [data-testid="connection-rule-remove-${uiRule.id}"]`,
      { visible: false }
    )
    assert.equal(
      Number(
        await control.command('getElementCount', `${content} [data-testid="connection-rule-runs"]`)
      ),
      0
    )
    assert.ok(
      (await request(`/v1/cloud-projects/${projectId}/automations`)).some(
        rule => rule.id === uiRule.cloudRuleId
      ),
      'Deleting a private rule through the UI changed unauthorized shared configuration'
    )
    await options.captureScreenshot(
      control,
      'connection-permissions-02-private-removal.png',
      content
    )
    console.log(
      '[source-rule-permissions] PASS real project 403, offline local management and private removal'
    )
  } catch (error) {
    failure = error
    throw error
  } finally {
    proxy.rule = () => null
    try {
      if (switched) {
        const rules = (await rpc('runtime.connection_rules.list', { userId: member.id })).items
        for (const rule of rules.filter(rule => rule.id.startsWith('permission-'))) {
          await rpc('runtime.connection_rules.remove', {
            userId: member.id,
            id: rule.id,
            version: rule.version,
          })
        }
        if (localProject) {
          const latest = (await rpc('projects.list', {})).find(
            project => project.id === localProject.id
          )
          await rpc('projects.archive', { project_id: latest.id, version: latest.version })
        }
        await restart({
          appEnvironmentOverrides: {
            WEWORK_E2E_CLOUD_TOKEN: environment.authToken,
            WEWORK_E2E_CLOUD_BACKEND_URL: environment.backendUrl,
          },
        })
        if (originalWindowSize) {
          await control.command('setMainWindowSize', 'body', { value: originalWindowSize })
        }
      }
      for (const rule of [cloudRule, uiRule].filter(Boolean)) {
        await request(`/v1/cloud-projects/${projectId}/automations/${rule.cloudRuleId}`, {
          method: 'DELETE',
        })
        await request(`/v1/cloud-projects/${projectId}/incoming-hooks/${rule.cloudHookId}`, {
          method: 'DELETE',
        })
      }
      await request(memberPath, { method: 'DELETE' })
    } catch (error) {
      if (!failure) throw error
      console.warn('[source-rule-permissions] Cleanup incomplete after the original failure')
    } finally {
      await proxy.stop()
    }
  }
}
