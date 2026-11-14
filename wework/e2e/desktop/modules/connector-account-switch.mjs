import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { pathExists, requestPluginExecutor, until } from './plugin-regression-fixture.mjs'
import { switchPersonalPluginAccount } from './plugin-personal-uninstall-flow.mjs'

/** Release an old account's real queued sync only after the new catalog is applied. */
export async function verifyConnectorAccountSwitch({ control, backend, api, slug, mcpUrl }) {
  const owner = await api('/api/users/me')
  const recipient = await api('/api/admin/users', {
    method: 'POST',
    body: {
      user_name: `connector-recipient-${process.pid}`,
      password: `Connector-E2E-${process.pid}-A1!`,
      role: 'user',
      auth_source: 'password',
    },
  })
  const restrictedSlug = `${slug}-admin-only`
  let restrictedId = 0
  let switched = false
  const status = async () => {
    const response = await requestPluginExecutor(control, 'runtime.connectors.status')
    assert.equal(response.status, 200)
    assert.equal(response.payload.ok, true, 'The real connector status RPC failed')
    return response.payload.result
  }
  const switchAccount = async cloud => {
    // The shared switch observes the workbench sidebar, not the settings sidebar.
    await control.command('navigate', 'body', { value: '/' })
    await switchPersonalPluginAccount(control, cloud)
    await control.command('navigate', 'body', { value: '/settings/connections' })
  }
  try {
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: {
        user_name: recipient.user_name,
        password: `Connector-E2E-${process.pid}-A1!`,
      },
    })
    assert.ok(login.access_token)
    const recipientCloud = { backendUrl: backend.backendUrl, authToken: login.access_token }

    // Both accounts have this callable tool. Otherwise missing tools would reject
    // the old payload even without the revision check, masking the actual defect.
    const session = await api(`/api/connector-apps/${slug}/oauth/sessions`, {
      method: 'POST',
      authToken: recipientCloud.authToken,
    })
    const consent = await fetch(session.authorize_url, { redirect: 'manual' })
    assert.equal(consent.status, 302)
    const callback = await fetch(consent.headers.get('location'))
    assert.equal(callback.status, 200)
    assert.match(await callback.text(), /Connector is connected/)
    const installed = await api('/api/apps/installed', { authToken: recipientCloud.authToken })
    assert.ok(installed.apps.find(app => app.slug === slug)?.tool_summaries.length > 0)
    const restricted = await api('/api/admin/connector-apps', {
      method: 'POST',
      body: {
        slug: restrictedSlug,
        name: 'Admin-only authorization guidance',
        transport: 'streamable-http',
        mcp_url: mcpUrl,
        auth_type: 'oauth2',
        visibility: 'roles',
        allowed_roles: [owner.role],
      },
    })
    restrictedId = restricted.id
    await api(`/api/connector-apps/${slug}/connection`, { method: 'DELETE' })
    await control.command('navigate', 'body', { value: '/settings/connections' })
    await control.command('waitFor', `[data-testid="connector-authorize-${slug}"]`)
    await control.command('clickWhenEnabled', `[data-testid="connector-authorize-${slug}"]`)
    await until(
      status,
      current => current.apps.some(app => app.slug === restrictedSlug),
      'The administrator fixture never published its restricted authorization Skill'
    )
    // Start one more same-account update and queue its fully assembled payload.
    // The old published catalog includes the restricted app, so its absence
    // below proves that the new account really finished its own synchronization.
    await api(`/api/connector-apps/${slug}/connection`, { method: 'DELETE' })
    await control.command('navigate', 'body', { value: '/' })
    await control.command('navigate', 'body', { value: '/settings/connections' })
    await control.command('waitFor', `[data-testid="connector-authorize-${slug}"]`)
    await control.command('holdLocalExecutorRequests', 'body', {
      value: JSON.stringify({
        method: 'runtime.connectors.apps.sync',
        phase: 'before-dispatch',
        maxHeldCount: 1,
      }),
    })
    await control.command('clickWhenEnabled', `[data-testid="connector-authorize-${slug}"]`)
    const held = JSON.parse(await control.command('awaitLocalExecutorRequestHold', 'body'))
    assert.equal(held.heldCount, 1)

    switched = true
    await switchAccount(recipientCloud)
    const next = await until(
      status,
      current =>
        current.configured &&
        current.apps.some(app => app.slug === slug) &&
        !current.apps.some(app => app.slug === restrictedSlug),
      'The new account catalog did not replace the administrator catalog'
    )
    // The settings surface also confirms this account cannot see the restricted app.
    await control.command('waitFor', `[data-testid="connector-connection-${slug}"]`)
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          `[data-testid="connector-connection-${restrictedSlug}"]`
        )
      ),
      0
    )
    assert.equal(await control.command('releaseLocalExecutorRequestHold', 'body'), 'true')
    await until(
      async () => JSON.parse(await control.command('getLocalExecutorRequestHoldSnapshot', 'body')),
      gate => gate.completedCount === 1,
      'The queued old-account request never completed'
    )
    assert.deepEqual(
      (await status()).apps,
      next.apps,
      'An old sync polluted the new account catalog'
    )
    const skillRoot = dirname(dirname(next.apps.find(app => app.slug === slug).skillPath))
    assert.equal(
      await pathExists(join(skillRoot, `wegent-connector-${restrictedSlug}`, 'SKILL.md')),
      false,
      'The old account installed its restricted authorization Skill for the new account'
    )
    return { oldSyncCompleted: true, restrictedCatalogAbsent: true, restrictedSkillAbsent: true }
  } finally {
    await control.command('releaseLocalExecutorRequestHold', 'body')
    if (switched) await switchAccount(backend)
    if (restrictedId) await api(`/api/admin/connector-apps/${restrictedId}`, { method: 'DELETE' })
    await api(`/api/admin/users/${recipient.id}`, { method: 'DELETE' })
  }
}
