import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function createGithubManageConnectionFixture(resultDir) {
  // Exercise the official GitHub route with a real local package, not a mocked
  // catalog service, online discovery, or inherited personal credentials.
  const marketplace = join(resultDir, 'github-marketplace')
  const plugin = join(marketplace, 'plugins', 'github')
  await mkdir(join(marketplace, '.agents', 'plugins'), { recursive: true })
  await mkdir(join(plugin, '.codex-plugin'), { recursive: true })
  await mkdir(join(plugin, 'skills', 'github'), { recursive: true })
  await writeFile(
    join(marketplace, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({
      name: 'openai-official',
      plugins: [{ name: 'github', source: { source: 'local', path: './plugins/github' } }],
    })
  )
  await writeFile(
    join(plugin, '.codex-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'github',
      version: '1.0.0',
      description: 'Real GitHub CLI manage-connection regression fixture',
      interface: { displayName: 'GitHub CLI regression' },
      skills: './skills/',
      connectors: [{ slug: 'github', authPolicy: 'on_use' }],
    })
  )
  await writeFile(
    join(plugin, 'skills', 'github', 'SKILL.md'),
    '---\nname: github\ndescription: GitHub CLI regression\n---\nUse gh to inspect GitHub repositories.\n'
  )
  return `\n[features]\nplugins = true\n\n[marketplaces.openai-official]\nsource_type = "local"\nsource = ${JSON.stringify(marketplace)}\n`
}

export async function verifyGithubManageConnectionConsent(control, previousSlug, previousId) {
  // The scenario owns an empty GH_CONFIG_DIR, never the developer's account.
  const loggedOut = JSON.parse(
    await control.command('localConnectorAuth', 'body', {
      value: JSON.stringify({
        pluginKey: 'github',
        connectorSlug: 'wework-github-cli',
        action: 'logout',
      }),
    })
  )
  assert.equal(loggedOut.status, 'ok', 'Empty CLI logout must be idempotent')
  assert.equal(loggedOut.connected, false, 'Empty CLI configuration must remain disconnected')
  await control.command('click', '[data-testid="plugins-button"]')
  await control.command('click', '[data-testid="plugin-detail-back-button"]')
  await control.command('waitFor', '[data-testid="plugins-search-input"]')
  await control.command('click', '[data-testid="plugins-distribution-tab-official"]')
  await control.command('fill', '[data-testid="plugins-search-input"]', {
    value: 'GitHub CLI regression',
  })
  const id = 'github@openai-official'
  await control.command('waitFor', `[data-testid="plugin-marketplace-install-${id}"]`)
  await control.command('click', `[data-testid="plugin-marketplace-install-${id}"]`)
  await control.command('waitFor', '[data-testid="install-plugin-dialog-confirm"]')
  await control.command('clickWhenEnabled', '[data-testid="install-plugin-dialog-confirm"]')
  await control.command('waitFor', `[data-testid="plugin-marketplace-actions-${id}"]`)
  await control.command('click', `[data-testid="plugin-marketplace-row-${id}"]`)
  const manage = '[data-testid="plugin-connection-manage-connector:github"]'
  await control.command('waitFor', manage, { text: '登录' })
  for (const attempt of ['initial', 'after-cancel']) {
    const row = JSON.parse(await control.command('snapshot', manage))
    assert.equal(row.text.trim(), '登录', `Unauthenticated CLI must offer login: ${attempt}`)
    await control.command('clickWhenEnabled', manage)
    await control.command('waitFor', '[data-testid="plugin-github-cli-auth-dialog"]')
    const consent = JSON.parse(await control.command('snapshot', 'body'))
    assert.ok(consent.testIds.includes('github-cli-login'), `No login consent: ${attempt}`)
    assert.ok(!consent.testIds.includes('github-cli-device-code'), 'Login began before consent')
    const metrics = async selector =>
      JSON.parse(await control.command('getElementMetrics', selector))[0]
    const viewport = await metrics('html')
    const dialog = await metrics('[data-testid="plugin-github-cli-auth-dialog"]')
    assert.ok(dialog.top >= 0 && dialog.bottom <= viewport.clientHeight, 'Login dialog is clipped')
    for (const button of ['github-cli-login', 'connector-auth-cancel']) {
      const bounds = await metrics('[data-testid="' + button + '"]')
      assert.ok(
        bounds.top >= dialog.top && bounds.bottom <= dialog.bottom,
        'Login action is clipped'
      )
      assert.ok(
        bounds.left >= 0 && bounds.right <= viewport.clientWidth,
        'Login action is offscreen'
      )
    }
    await control.command('click', '[data-testid="connector-auth-cancel"]')
    await control.command('waitFor', '[data-testid="plugin-detail-action-error"]')
  }
  await control.command('click', '[data-testid="plugin-detail-back-button"]')
  await control.command('click', '[data-testid="plugins-distribution-tab-all"]')
  await control.command('fill', '[data-testid="plugins-search-input"]', { value: previousSlug })
  await control.command('click', `[data-testid="plugin-marketplace-row-${previousId}"]`)
  await control.command('waitFor', '[data-testid="plugin-connection-manage-group:sites"]')
}
