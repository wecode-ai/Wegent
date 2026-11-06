// Internal protocol integration: real Backend, Redis, Executor and HTTP ingress.
// No claim of live GitHub/GitLab compatibility is made by this scenario.
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createGitReadonlyVerification } from '../modules/stand-in-git-readonly.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { openConnectionTypePicker } from '../modules/stand-in-flows.mjs'

export function createDesktopScenario({ uiTimeoutMs, captureScreenshot, modelResponseTimeoutMs }) {
  let cloud
  const request = async (
    path,
    method = 'GET',
    body,
    status = 200,
    headers = {},
    token = cloud.authToken
  ) => {
    const response = await fetch(`${cloud.backendUrl}/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      signal: AbortSignal.timeout(uiTimeoutMs),
    })
    assert.equal(response.status, status, `${method} ${path} status`)
    return response.json()
  }
  const live = createGitReadonlyVerification({
    request,
    captureScreenshot,
    uiTimeoutMs,
    modelResponseTimeoutMs,
  })
  return {
    requiresCloudEnvironment: true,
    handleHttp: live.handleHttp,
    prepareApp: live.prepareApp,
    setRestartDesktopApp: live.setRestartDesktopApp,
    async prepareCloud(environment) {
      cloud = environment
    },
    async verify(control) {
      const catalog = await requestExecutor(control, 'runtime.connections.catalog', {}, uiTimeoutMs)
      for (const platform of ['github', 'gitlab'])
        assert.ok(catalog.items.some(row => row.id === `@wegent/dsh-connection-git/${platform}`))
      const user = await request('/users/me')
      const settings = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: user.id },
        uiTimeoutMs
      )
      const deviceId = settings.executionDeviceId
      await request('/admin/setup-complete', 'POST', {})
      const userName = `git-inbox-outsider-${process.pid}-${Date.now()}`
      const password = 'git-inbox-protocol-e2e'
      await request(
        '/admin/users',
        'POST',
        { user_name: userName, password, role: 'user', auth_source: 'password' },
        201
      )
      const outsider = await request('/auth/login', 'POST', { user_name: userName, password })
      const source = {
        provider: 'github',
        instance: 'https://github.com',
        accountId: '7',
        repositoryId: '42',
        repositoryPath: 'protocol/repository',
      }
      const created = await request('/v1/git-connections/subscriptions', 'POST', {
        deviceId,
        source,
      })
      const base = `/v1/git-connections/subscriptions/${created.id}`
      const binding = { deviceId, generation: created.generation }
      let cleanupBinding = binding
      try {
        await request(
          `${base}/events`,
          'POST',
          { ...binding, after: 0 },
          404,
          {},
          outsider.access_token
        )
        await request(base, 'DELETE', binding, 404, {}, outsider.access_token)
        await request(
          `${base}/configuration`,
          'POST',
          { ...binding, reveal: true },
          404,
          {},
          outsider.access_token
        )
        const payload = JSON.stringify({
          repository: { id: 42, full_name: 'protocol/repository' },
          future_payload: { retained: true },
        })
        const headers = {
          'x-github-event': 'future_event',
          'x-github-delivery': 'stable-delivery',
          'x-hub-signature-256': `sha256=${createHmac('sha256', created.secret).update(payload).digest('hex')}`,
        }
        await request(`/v1/git-connections/hooks/${created.id}`, 'POST', payload, 401, {
          ...headers,
          'x-hub-signature-256': 'sha256=invalid',
        })
        await request(`/v1/git-connections/hooks/${created.id}`, 'POST', payload, 200, headers)
        await request(`/v1/git-connections/hooks/${created.id}`, 'POST', payload, 200, headers)
        await request(
          `${base}/events`,
          'POST',
          { ...binding, deviceId: 'wrong-device', after: 0 },
          409
        )
        const first = await requestExecutor(
          control,
          'runtime.connections.git.webhooks',
          {
            operation: 'events',
            subscriptionId: created.id,
            generation: created.generation,
            after: 0,
          },
          uiTimeoutMs
        )
        assert.equal(first.items.length, 1)
        assert.equal(first.items[0].eventType, 'future_event')
        assert.deepEqual(first.items[0].payload.future_payload, { retained: true })
        const replay = await request(`${base}/events`, 'POST', { ...binding, after: 0 })
        assert.deepEqual(replay.items, first.items, 'unacknowledged events remain available')
        await requestExecutor(
          control,
          'runtime.connections.git.webhooks',
          {
            operation: 'ack',
            subscriptionId: created.id,
            generation: created.generation,
            sequence: first.items[0].sequence,
          },
          uiTimeoutMs
        )
        const listed = await request('/v1/git-connections/subscriptions')
        assert.equal(
          listed.items.find(row => row.id === created.id).confirmedSequence,
          first.items[0].sequence
        )
        assert.ok(!JSON.stringify(listed).includes(created.secret))
        const takeover = await request(base, 'PUT', { ...binding, deviceId: 'other-device' })
        cleanupBinding = { deviceId: 'other-device', generation: takeover.generation }
        await request(base, 'DELETE', binding, 409)
        await request(`${base}/events`, 'POST', { ...binding, after: 0 }, 409)
        await request(
          `${base}/ack`,
          'POST',
          { deviceId: 'other-device', generation: takeover.generation, sequence: 999999999 },
          400
        )
      } finally {
        await request(base, 'DELETE', cleanupBinding)
      }
      const receiver = await request('/v1/git-connections/subscriptions', 'POST', {
        deviceId: 'previous-computer',
        source: { ...source, profile: JSON.stringify(['https://github.com', '7']) },
      })
      const receiver2 = await request('/v1/git-connections/subscriptions', 'POST', {
        deviceId,
        source: {
          ...source,
          profile: JSON.stringify(['https://github.com', '7']),
          repositoryId: '43',
          repositoryPath: 'protocol/a-long-repository-name-for-layout-verification',
        },
      })
      const openGit = async platform => {
        await openConnectionTypePicker(control)
        await control.command(
          'clickWhenEnabled',
          `[data-testid="stand-in-add-@wegent/dsh-connection-git/${platform}-connection"]`
        )
        await control.command('waitFor', `[data-testid="stand-in-git-${platform}"]`)
      }
      try {
        await ensureExperimentalFeaturesEnabled(control)
        for (const target of [
          'workspace-tab-select-fixed-board',
          'workspace-tab-select-fixed-task',
          'personal-stand-in-button',
        ])
          await control.command('clickWhenEnabled', `[data-testid="${target}"]`)
        // This protocol fixture installs its connection host on the local Executor.
        await control.command('waitFor', '[data-testid="stand-in-workspace-location"]')
        await control.command('select', '[data-testid="stand-in-workspace-location"]', {
          value: deviceId,
        })
        await control.command('clickWhenEnabled', '[data-testid="stand-in-settings-open"]')
        await control.command(
          'clickWhenEnabled',
          '[data-testid="stand-in-primary-connections-open"]'
        )
        await openGit('github')
        const personalView = JSON.parse(await control.command('snapshot', 'body'))
        assert.match(personalView.text, /个人全部事件/)
        assert.match(personalView.text, /只关注某个仓库/)
        assert.doesNotMatch(personalView.text, /Webhook|轮询/)
        assert.equal(
          Number(
            await control.command('getElementCount', '[data-testid^="stand-in-git-takeover-"]')
          ),
          0
        )
        await captureScreenshot(control, 'git-01-personal-scope-without-cloud-controls.png')
        await control.command('select', '[data-testid="stand-in-git-kind"]', {
          value: 'repository',
        })
        await control.command('fill', '[data-testid="stand-in-git-query"]', { value: 'wegent' })
        await captureScreenshot(control, 'git-02-repository-scope-search-layout.png')
        const remote = await request('/v1/git-connections/subscriptions')
        assert.equal(remote.items.find(row => row.id === receiver.id).deviceId, 'previous-computer')
        assert.equal(
          remote.items.find(row => row.id === receiver.id).generation,
          receiver.generation
        )
        await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-cancel"]')
        await control.command('waitFor', '[data-testid="stand-in-primary-profile"]', {
          visible: false,
        })
        const persisted = await requestExecutor(
          control,
          'runtime.stand_in.personal.get',
          { userId: user.id },
          uiTimeoutMs
        )
        assert.equal(
          Boolean(persisted.primary?.connections?.some(row => row.subscriptionId === receiver.id)),
          false
        )
        await control.command('clickWhenEnabled', '[data-testid="stand-in-settings-open"]')
        await control.command(
          'clickWhenEnabled',
          '[data-testid="stand-in-primary-connections-open"]'
        )
        await openGit('gitlab')
        await control.command('select', '[data-testid="stand-in-git-kind"]', {
          value: 'repository',
        })
        await control.command('fill', '[data-testid="stand-in-git-query"]', { value: 'wegent' })
        await captureScreenshot(control, 'git-03-light-gitlab-repository-search.png')
        await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-cancel"]')
        await control.command('waitFor', '[data-testid="stand-in-primary-profile"]', {
          visible: false,
        })
        await control.command('navigate', 'body', { value: '/settings/appearance' })
        await control.command('clickWhenEnabled', '[data-testid="appearance-mode-dark"]')
        await control.command('waitFor', 'html[data-theme="dark"]')
        await control.command('setMainWindowSize', 'body', {
          value: JSON.stringify({ width: 1000, height: 760 }),
        })
        await control.command('navigate', 'body', { value: '/stand-in' })
        for (const target of ['stand-in-settings-open', 'stand-in-primary-connections-open'])
          await control.command('clickWhenEnabled', `[data-testid="${target}"]`)
        await openGit('gitlab')
        await captureScreenshot(control, 'git-04-narrow-dark-gitlab-personal-scope.png')
        await control.command('select', '[data-testid="stand-in-git-kind"]', {
          value: 'repository',
        })
        await control.command('fill', '[data-testid="stand-in-git-query"]', { value: 'wegent' })
        await captureScreenshot(control, 'git-05-narrow-dark-gitlab-repository-search.png')
        await control.command('fill', '[data-testid="stand-in-git-instance"]', {
          value: 'http://gitlab.invalid',
        })
        await control.command('clickWhenEnabled', '[data-testid="stand-in-git-search"]')
        await control.command('waitFor', '[role="alert"]')
        await captureScreenshot(control, 'git-06-invalid-instance-actionable-error.png')
        await control.command('fill', '[data-testid="stand-in-git-instance"]', {
          value: 'https://gitlab.com',
        })
        await control.command('waitFor', '[role="alert"]', { visible: false })
      } finally {
        await request(`/v1/git-connections/subscriptions/${receiver.id}`, 'DELETE', {
          deviceId: 'previous-computer',
          generation: receiver.generation,
        })
        await request(`/v1/git-connections/subscriptions/${receiver2.id}`, 'DELETE', {
          deviceId,
          generation: receiver2.generation,
        })
      }
      const gitlab = await request('/v1/git-connections/subscriptions', 'POST', {
        deviceId,
        source: { ...source, provider: 'gitlab', instance: 'https://gitlab.example' },
      })
      try {
        const path = `/v1/git-connections/hooks/${gitlab.id}`
        const payload = { project_id: 42, object_kind: 'future_gitlab_event' }
        const headers = {
          'x-gitlab-event': 'Future Hook',
          'x-gitlab-event-uuid': 'gitlab-delivery',
          'x-gitlab-token': gitlab.secret,
        }
        await request(path, 'POST', payload, 401, { ...headers, 'x-gitlab-token': 'invalid' })
        await request(path, 'POST', payload, 200, headers)
        await request(path, 'POST', payload, 200, headers)
        const result = await request(
          `/v1/git-connections/subscriptions/${gitlab.id}/events`,
          'POST',
          { deviceId, generation: gitlab.generation, after: 0 }
        )
        assert.equal(result.items.length, 1)
        assert.equal(result.items[0].eventType, 'Future Hook')
        assert.deepEqual(result.items[0].payload, payload)
      } finally {
        await request(`/v1/git-connections/subscriptions/${gitlab.id}`, 'DELETE', {
          deviceId,
          generation: gitlab.generation,
        })
      }
      await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-cancel"]')
      await live.verify(control, user.id)
    },
  }
}
