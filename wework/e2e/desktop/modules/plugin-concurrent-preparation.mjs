import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CLOUD_DEVICE_ID } from './shared.mjs'
import {
  accountPlugin,
  materializedPlugin,
  pluginApi,
  testId,
  until,
} from './plugin-regression-fixture.mjs'

// Reuse the checkpoint's real S3 proxy, backend, and remote Executor. Only the
// transport is paused; every package byte and capability receipt remains real.
export async function verifyConcurrentPluginPreparation({
  cloud,
  control,
  packageProxy,
  remoteHome,
  evidence,
  timeoutMs,
}) {
  await control.command('click', testId('new-chat-button'))
  const publish = slug =>
    cloud.publishPluginRelease({
      slug,
      version: '1.0.0',
      skills: { [slug]: `Concurrent preparation ${slug}` },
    })
  const slow = {
    ...(await publish('coordination-e2e-slow-preparation')),
    slug: 'coordination-e2e-slow-preparation',
  }
  const fast = {
    ...(await publish('coordination-e2e-fast-preparation')),
    slug: 'coordination-e2e-fast-preparation',
  }
  const query = `device_id=${encodeURIComponent(CLOUD_DEVICE_ID)}`
  const start = packageProxy.requests.length
  const downloads = () =>
    packageProxy.requests
      .slice(start)
      .filter(request => request.method === 'GET' && request.path.endsWith(`/${slow.storageKey}`))
  packageProxy.rule = request =>
    request.method === 'GET' && request.path.endsWith(`/${slow.storageKey}`)
      ? 'hold-response'
      : null
  let pending
  try {
    pending = pluginApi(
      cloud,
      `/plugins/marketplace/${slow.pluginId}/install?${query}`,
      'POST'
    ).then(
      value => ({ value }),
      error => ({ error })
    )
    await until(
      downloads,
      requests => requests.some(request => request.committedResponseHeld),
      'The slow installation did not reach the real package download gate',
      timeoutMs
    )
    const account = await accountPlugin(cloud, slow.slug)
    assert.ok(account, 'Package preparation started before account installation committed')
    slow.installedId = Number(account.metadata.labels.id)
    const installedFast = await pluginApi(
      cloud,
      `/plugins/marketplace/${fast.pluginId}/install?${query}`,
      'POST',
      { signal: AbortSignal.timeout(Math.min(timeoutMs, 30_000)) }
    )
    fast.installedId = Number(installedFast.plugin.metadata.labels.id)
    assert.equal(
      installedFast.sync.success,
      true,
      'The independent plugin did not finish before the slow download was released'
    )
    assert.ok(await materializedPlugin(remoteHome, fast.installedId))
    assert.equal(await materializedPlugin(remoteHome, slow.installedId), null)
    assert.ok(
      downloads().every(request => !request.released),
      'The test released the slow download too early'
    )

    // A newer removal must be accepted while the older package is still in
    // preparation, then fence its publication rather than restoring the plugin.
    await pluginApi(cloud, `/plugins/installed/${slow.installedId}?${query}`, 'DELETE')
    await until(
      async () =>
        JSON.parse(await readFile(resolve(remoteHome, 'capabilities/manifest-v2.json'), 'utf8')),
      manifest => Boolean(manifest.plugin_sync?.removals?.[slow.installedId]?.pending),
      'The uninstall intent was blocked behind the package download',
      timeoutMs
    )
    packageProxy.rule = () => null
    for (const request of downloads())
      if (request.committedResponseHeld && !request.released) await request.release()
    const completed = await pending
    if (completed.error) throw completed.error
    await until(
      async () => ({
        account: await accountPlugin(cloud, slow.slug),
        runtime: await materializedPlugin(remoteHome, slow.installedId),
        rows: await cloud.queryDatabase(
          'SELECT state FROM plugin_device_installations WHERE user_id = %s AND installed_kind_id = %s AND device_id = %s',
          [1, slow.installedId, CLOUD_DEVICE_ID]
        ),
      }),
      state => !state.account && !state.runtime && state.rows.length === 0,
      'The old installation survived its newer uninstall intent',
      timeoutMs
    )
    assert.ok(
      await materializedPlugin(remoteHome, fast.installedId),
      'Removing the slow plugin damaged the independent installation'
    )
    evidence.push({
      case: 'concurrent-preparation-and-uninstall-fence',
      slowInstalledId: slow.installedId,
      fastInstalledId: fast.installedId,
      fastCompletedBeforeSlowRelease: true,
      oldInstallDidNotResurrect: true,
    })
  } finally {
    packageProxy.rule = () => null
    for (const request of downloads())
      if (request.committedResponseHeld && !request.released) await request.release()
    if (pending) await pending
    for (const item of [slow, fast]) {
      const account = await accountPlugin(cloud, item.slug)
      if (account)
        await pluginApi(
          cloud,
          `/plugins/installed/${Number(account.metadata.labels.id)}?${query}`,
          'DELETE'
        )
    }
  }
}
