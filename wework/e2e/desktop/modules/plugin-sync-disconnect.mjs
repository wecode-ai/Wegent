import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { openComposerPluginPicker } from './conversation-layout.mjs'
import {
  assertInventory,
  assertSurfaces,
  installFixture,
  materializedPlugin,
  openPlugin,
  testId,
  until,
} from './plugin-regression-fixture.mjs'

// Dropping the real Socket.IO connection loses the original capability ACK.
// Backend's production SYNC_TIMEOUT_SECONDS is 180; keep that timeout intact.
const SYNC_ACK_RECOVERY_TIMEOUT_MS = 210_000

export async function verifyPluginSyncDisconnect({
  cloud,
  control,
  apiProxy,
  packageProxy,
  executorHome,
  localDeviceId,
  evidence,
  timeoutMs,
}) {
  const slug = 'coordination-e2e-disconnect'
  const nextSkill = 'Plugin sync recovered after the real connection was interrupted'
  const item = await installFixture(cloud, control, slug, localDeviceId, timeoutMs)
  const diagnostics = async () =>
    JSON.parse(await control.command('getPluginSyncDiagnostics', 'body', { value: localDeviceId }))
  const starts = state => state.localCatalogReads.filter(read => read.phase === 'started')
  const installedVersion = async () => {
    const plugin = await materializedPlugin(executorHome, item.installedId)
    if (!plugin?.runtime?.codex_link) return null
    const runtimePath = resolve(executorHome, 'capabilities', plugin.runtime.codex_link)
    const manifest = JSON.parse(
      await readFile(join(runtimePath, '.codex-plugin/plugin.json'), 'utf8')
    )
    return { plugin, runtimePath, version: manifest.version }
  }
  await until(
    installedVersion,
    installed => installed?.version === '1.0.0',
    'The real local Executor did not install the baseline package',
    timeoutMs
  )
  await openPlugin(control, item)
  await until(
    diagnostics,
    state =>
      state.backend.connected &&
      state.rendererConnected &&
      !state.inFlight &&
      starts(state).length ===
        state.localCatalogReads.filter(read => read.phase !== 'started').length,
    'Initial plugin reconciliation did not settle before the update'
  )
  assert.ok(apiProxy.websockets.size > 0, 'Local connection bypassed the real fault proxy')

  const requestStart = apiProxy.requests.length
  const packageStart = packageProxy.requests.length
  const packageGets = () =>
    packageProxy.requests
      .slice(packageStart)
      .filter(
        request =>
          request.method === 'GET' &&
          request.path.includes(`/plugins/${item.pluginId}/`) &&
          !request.path.endsWith(`/${item.storageKey}`)
      )
  const syncPosts = () =>
    apiProxy.requests
      .slice(requestStart)
      .filter(
        request =>
          request.method === 'POST' &&
          (request.path === '/api/plugins/installed/sync-device' ||
            request.path === `/api/plugins/installed/${item.installedId}/sync-device`)
      )
  packageProxy.rule = request =>
    request.method === 'GET' &&
    request.path.includes(`/plugins/${item.pluginId}/`) &&
    !request.path.endsWith(`/${item.storageKey}`)
      ? 'hold-response'
      : null
  let held
  try {
    const release = await cloud.publishPluginRelease({
      slug,
      version: '2.0.0',
      skills: { [slug]: nextSkill },
    })
    // The actual publication event and mounted PluginsWorkspace/auto-update
    // coordinator acquire the shared lock and perform the real sync POST.
    held = await until(
      packageGets,
      requests => requests.some(request => request.committedResponseHeld),
      'Automatic update did not reach the held real MinIO package download',
      timeoutMs
    ).then(requests => requests.find(request => request.committedResponseHeld))
    assert.equal(held.status, 200, 'MinIO rejected the signed package request')
    assert.ok(held.path.endsWith(`/${release.storageKey}`))
    const pending = await until(
      diagnostics,
      state => state.inFlight,
      'Real package synchronization did not hold the renderer single-flight lock'
    )
    assert.equal(syncPosts().length, 1, 'Expected one renderer-initiated device sync')
    assert.equal(syncPosts()[0].status, undefined, 'Sync returned before package bytes arrived')
    assert.equal((await installedVersion()).version, '1.0.0')
    const initialStarts = starts(pending).length
    const assertNoReconciliation = state => {
      assert.equal(
        starts(state).length,
        initialStarts,
        'Local catalog reconciliation raced the unfinished package synchronization'
      )
      assert.equal(syncPosts().length, 1, 'Connection churn started a duplicate device sync')
    }

    // Re-enter with a fresh workspace while the original owner still holds
    // the shared sync lock. A stale deferred-request key cannot hide an early
    // read, and the original workspace's completion cannot refresh this one.
    await control.command('click', testId('new-chat-button'))
    assertNoReconciliation(await diagnostics())
    apiProxy.disconnectWebSockets(true)
    const disconnected = await until(
      diagnostics,
      state => {
        assert.equal(state.inFlight, true, 'Sync lock vanished while its package was held')
        assertNoReconciliation(state)
        return !state.backend.connected && !state.rendererConnected
      },
      'The real Executor and renderer did not observe the transport disconnect'
    )
    assert.equal((await installedVersion()).version, '1.0.0')
    assert.equal(held.released, undefined, 'Package bytes escaped the transport barrier')
    await openPlugin(control, item)
    await control.command('waitFor', testId(`plugin-marketplace-row-${item.pluginId}`))
    const remounted = await diagnostics()
    assert.equal(remounted.inFlight, true)
    assert.equal(remounted.backend.connected, false)
    assert.equal(remounted.rendererConnected, false)
    assertNoReconciliation(remounted)

    packageProxy.rule = () => null
    await held.release()
    const materialized = await until(
      installedVersion,
      installed => installed?.version === '2.0.0',
      'Releasing the real package did not materialize the new local version',
      timeoutMs
    )
    assert.match(
      await readFile(join(materialized.runtimePath, 'skills', slug, 'SKILL.md'), 'utf8'),
      new RegExp(nextSkill)
    )
    const released = await diagnostics()
    assert.equal(released.inFlight, true, 'The disconnected sync settled without its real ACK')
    assertNoReconciliation(released)

    apiProxy.disconnectWebSockets(false)
    await until(
      diagnostics,
      state => {
        if (state.inFlight) assertNoReconciliation(state)
        return state.backend.connected && state.rendererConnected
      },
      'The real Executor did not reconnect after the transport recovered',
      timeoutMs
    )
    // Keep the remounted workspace open through recovery. Reconciliation must
    // resume automatically after synchronization, without a manual refresh.
    const recovered = await until(
      diagnostics,
      state => {
        if (syncPosts()[0].status === undefined) {
          assert.equal(state.inFlight, true, 'Sync lock released before its request settled')
          assertNoReconciliation(state)
          return false
        }
        if (state.inFlight) return false
        const newStarts = starts(state).slice(initialStarts)
        return newStarts.some(start =>
          state.localCatalogReads.some(
            read => read.phase === 'completed' && read.startedAt === start.startedAt
          )
        )
      },
      'Mounted PluginsWorkspace did not resume reconciliation after the sync lock released',
      SYNC_ACK_RECOVERY_TIMEOUT_MS
    )
    assert.equal(syncPosts()[0].status, 200, 'The real sync request never completed')
    assert.equal(syncPosts().length, 1, 'Recovery repeated the foreground device sync')
    assert.equal(packageGets().length, 1, 'Reconnect downloaded the immutable package twice')
    await control.command('waitFor', testId(`plugin-marketplace-actions-${item.pluginId}`))
    await control.command('click', testId('new-chat-button'))
    await openComposerPluginPicker(control)
    await assertInventory(control, slug, true)
    await control.command('click', testId('composer-plugin-picker-button'))
    await openPlugin(control, item)
    await assertSurfaces(control, item, true)
    await openComposerPluginPicker(control)
    await control.command('fill', testId('composer-plugin-picker-search'), { value: slug })
    await control.command('click', testId(`composer-plugin-picker-item-plugin:${slug}`))
    await control.command('waitFor', testId(`composer-plugin-chip-${slug}`))
    assert.equal(syncPosts().length, 1, 'Reopening the workspace repeated a completed device sync')
    assert.equal(packageGets().length, 1, 'Reopening downloaded the installed package again')
    evidence.push({
      case: 'package-sync-disconnect-defers-local-catalog',
      installedId: item.installedId,
      releaseId: release.releaseId,
      initialStarts,
      disconnected,
      remounted,
      released,
      recovered,
      syncRequests: syncPosts(),
      packageRequests: packageGets(),
    })
  } finally {
    apiProxy.disconnectWebSockets(false)
    packageProxy.rule = () => null
    for (const request of packageGets()) {
      if (request.committedResponseHeld && !request.released) await request.release()
    }
  }
}
