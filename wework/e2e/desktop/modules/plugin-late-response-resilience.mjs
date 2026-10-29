import assert from 'node:assert/strict'
import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import {
  accountPlugin,
  assertInventory,
  completedApiResourceTimings,
  inventory,
  materializedPlugin,
  openPlugin,
  testId,
  until,
} from './plugin-regression-fixture.mjs'
import { runtimeTransportGates } from './runtime-transport-gates.mjs'

function jsonResponse(delayed) {
  const encoding = delayed.headers['content-encoding']
  const decoders = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync }
  assert.ok(!encoding || decoders[encoding], 'Unexpected real response encoding')
  const bytes = encoding ? decoders[encoding](delayed.body) : delayed.body
  return JSON.parse(bytes.toString('utf8'))
}

/** Delay original catalog bytes while a real disk scan updates only the adapter cache. */
export async function verifyCatalogDiskGeneration({
  control,
  executorHome,
  item,
  apiProxy,
  deviceId,
  report,
}) {
  const gates = runtimeTransportGates(control)
  const gateId = 'plugin-catalog-after-newer-disk'
  const home = await realpath(executorHome)
  const path = join(home, 'capabilities/manifest-v2.json')
  assert.equal(await realpath(path), path, 'The isolated manifest must not be a symlink')
  const metadata = await lstat(path)
  assert.ok(metadata.isFile() && metadata.nlink === 1)
  const original = await readFile(path)
  const manifest = JSON.parse(original)
  const targets = Object.entries(manifest.plugins).filter(
    ([, plugin]) => Number(plugin.installed_plugin_id) === item.installedId
  )
  assert.equal(targets.length, 1, 'The real installed store fixture must exist before delaying')
  const injected = Buffer.from(
    JSON.stringify({
      ...manifest,
      plugins: Object.fromEntries(
        Object.entries(manifest.plugins).filter(([key]) => key !== targets[0][0])
      ),
    })
  )
  const staging = `${path}.catalog-generation-${process.pid}.tmp`
  const replace = async bytes => {
    try {
      await writeFile(staging, bytes, { flag: 'wx', mode: metadata.mode & 0o777 })
      await rename(staging, path)
    } finally {
      await rm(staging, { force: true })
    }
  }
  const previousRule = apiProxy.rule
  const delayedRepairs = []
  const repairOutcomes = new Map()
  const failures = []
  try {
    // Keep legitimate automatic repairs from changing the fault before assertions.
    apiProxy.rule = request => {
      if (request.method === 'POST' && request.path.startsWith('/api/plugins/installed/')) {
        delayedRepairs.push(request)
        return 'pause-request'
      }
      return previousRule(request)
    }
    await control.command('waitFor', testId('plugins-refresh-button'), {
      enabled: true,
      stableMs: 250,
    })
    const before = await inventory(control)
    report.before = before
    await gates.arm({
      id: gateId,
      kind: 'response',
      name: 'codex.app_server_request',
      where: [{ path: 'params.method', equals: 'plugin/list' }],
    })
    await control.command('click', testId('plugins-refresh-button'))
    const capture = await gates.wait(gateId)
    report.catalogCapture = { capturedAt: capture.capturedAt, deliveries: capture.deliveries }
    assert.equal(capture.deliveries, 0, 'The old real catalog response must still be held')
    const held = await inventory(control)
    assert.equal(held.installedSourceReads.store.status, 'fulfilled')
    assert.ok(held.installedSourceReads.store.pluginKeys.includes(item.slug))
    await replace(injected)
    const disk = JSON.parse(await control.command('readLocalPluginDiskInventory', 'body'))
    report.disk = disk
    assert.equal(disk.partial, false, 'The newer disk read must succeed completely')
    assert.equal(disk.sourceReads.store.status, 'fulfilled')
    assert.ok(!disk.sourceReads.store.pluginKeys.includes(item.slug))
    assert.ok((await readFile(path)).equals(injected), 'Background work changed the disk fixture')
    const afterDisk = await inventory(control)
    report.afterDisk = afterDisk
    assert.equal(
      afterDisk.sharedInventory.mutationRevision,
      before.sharedInventory.mutationRevision,
      'A shared inventory mutation must not mask the adapter-only race'
    )
    assert.deepEqual(
      afterDisk.sharedInventory.localInstalledSources,
      held.sharedInventory.localInstalledSources,
      'Only the adapter cache may change before releasing the catalog'
    )
    assert.deepEqual(
      afterDisk.sharedInventory.localInstalledSourceStatus,
      held.sharedInventory.localInstalledSourceStatus
    )
    await gates.release(gateId)
    await control.command('waitFor', testId('plugins-refresh-button'), {
      enabled: true,
      stableMs: 250,
    })
    const after = await inventory(control)
    report.afterCatalog = after
    assert.equal(after.installedSourceReads.store.status, 'fulfilled')
    assert.ok(
      !after.installedSourceReads.store.pluginKeys.includes(item.slug),
      'The old catalog restored removed store source records'
    )
    const otherSourceContains = ['codex', 'personal'].some(source =>
      after.installedSourceReads[source]?.pluginKeys.includes(item.slug)
    )
    assert.equal(
      after.installedPlugins.some(plugin => plugin.pluginKey === item.slug),
      otherSourceContains,
      'Flat adapter records must agree with their source records'
    )
    const targetIds = after.sharedInventory.installedPlugins
      .filter(plugin => plugin.pluginKey === item.slug)
      .map(plugin => plugin.inventoryId)
    assert.ok(
      targetIds.every(id => !after.sharedInventory.localInstalledSources.store?.includes(id)),
      'The shared inventory restored removed store ownership from the old catalog'
    )
    assert.equal((await gates.read(gateId)).deliveries, 1)
    assert.ok(
      (await readFile(path)).equals(injected),
      'The successful assertion must observe the injected disk state'
    )
    Object.assign(report, {
      assertionsPassed: true,
      flatContainsFixture: otherSourceContains,
      storeOwnershipRemoved: true,
    })
  } catch (error) {
    report.assertionError = String(error?.stack ?? error)
    failures.push(error)
  } finally {
    report.cleanupErrors = []
    const cleanup = async (label, action) => {
      try {
        await action()
      } catch (error) {
        report.cleanupErrors.push({ label, error: String(error?.stack ?? error) })
        failures.push(error)
      }
    }
    let restored = false
    await cleanup('restore-manifest', async () => {
      await replace(original)
      restored = true
    })
    apiProxy.rule = previousRule
    await cleanup('reset-catalog-gate', () => gates.reset())
    await cleanup('finish-paused-repairs', async () => {
      try {
        for (const request of delayedRepairs) {
          assert.equal(request.fault, 'pause-request')
          assert.equal(typeof request.release, 'function')
          assert.equal(typeof request.cancel, 'function')
          repairOutcomes.set(request, restored ? request.release() : request.cancel())
        }
        await until(
          () => delayedRepairs,
          requests => requests.every(request => request.responseCompleted || request.cancelled),
          'Paused repairs did not complete after restoring the manifest'
        )
      } finally {
        // On timeout, close outstanding real transports so later groups are not poisoned.
        for (const request of delayedRepairs) request.cancel()
      }
    })
    if (delayedRepairs.length)
      await cleanup('wait-device-sync-unlocked', async () => {
        await until(
          async () =>
            JSON.parse(
              await control.command('getPluginSyncDiagnostics', 'body', { value: deviceId })
            ),
          state => !state.inFlight,
          'The device synchronization lock remained held after cleanup'
        )
      })
    report.repairs = delayedRepairs.map(request => ({
      path: request.path,
      fault: request.fault,
      releaseAccepted: repairOutcomes.get(request) === true,
      released: request.released === true,
      cancelled: request.cancelled === true,
      responseCompleted: request.responseCompleted === true,
    }))
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1)
    throw new AggregateError(failures, 'Catalog/disk concurrency assertions and cleanup failed', {
      cause: failures[0],
    })
  await control.command('clickWhenEnabled', testId('plugins-refresh-button'))
  await control.command('waitFor', testId('plugins-refresh-button'), {
    enabled: true,
    stableMs: 250,
  })
  const recovered = await inventory(control)
  assert.ok(
    recovered.installedSourceReads.store.pluginKeys.includes(item.slug),
    'A fresh read must restore the real store source after cleanup'
  )
  report.passed = true
  return report
}

/** A completed older real read must not undo a confirmed UI installation. */
export async function verifyPluginLateResponseResilience({
  cloud,
  control,
  apiProxy,
  deviceId,
  executorHome,
  resultDir,
  captureScreenshot,
}) {
  const report = {
    scope:
      'Older installed and catalog responses cannot undo a real installation or a newer disk source read',
    passed: false,
    preconditions: { completed: false },
  }
  const started = Date.now()
  const requestStart = apiProxy.requests.length
  let delayedEntry
  try {
    const slug = 'late-response-installed-after-read'
    const item = {
      ...(await cloud.publishPluginRelease({
        slug,
        version: '1.0.0',
        skills: { 'late-response-check': 'Real delayed inventory regression' },
      })),
      slug,
    }
    await control.command('click', testId('new-chat-button'))
    await openPlugin(control, item)
    await control.command('clickWhenEnabled', testId('plugins-refresh-button'))
    await control.command('waitFor', testId(`plugin-marketplace-row-${item.pluginId}`))
    await control.command('waitFor', testId('plugins-refresh-button'), {
      enabled: true,
      stableMs: 250,
    })
    assert.equal(await accountPlugin(cloud, slug), undefined)
    report.preconditions.completed = true
    // Expand the browser observation buffer before starting the delayed request.
    await completedApiResourceTimings(control, '/api/plugins/installed')
    apiProxy.rule = entry => {
      if (!delayedEntry && entry.method === 'GET' && entry.path === '/api/plugins/installed') {
        delayedEntry = entry
        return 'hold-response'
      }
      return null
    }
    const olderReadStartedAt = Date.now()
    await control.command('click', testId('plugins-refresh-button'))
    await until(
      () => delayedEntry?.committedResponseHeld,
      Boolean,
      'The app did not receive and delay a real completed installed-list response'
    )
    const held = delayedEntry.readHeldResponse()
    assert.ok(held, 'The completed response was not held before installing')
    const older = jsonResponse(held)
    assert.ok(Array.isArray(older.items))
    assert.ok(!older.items.some(plugin => plugin.spec.source.pluginKey === slug))
    report.olderResponse = {
      status: delayedEntry.status,
      fixtureAbsent: true,
      requestIndex: apiProxy.requests.indexOf(delayedEntry),
    }
    const heldReadyAt = Date.now()

    await control.command(
      'clickWhenEnabled',
      `button${testId(`plugin-marketplace-install-${item.pluginId}`)}`
    )
    await control.command('waitFor', testId('install-plugin-dialog-confirm'))
    await control.command('clickWhenEnabled', testId('install-plugin-dialog-confirm'))
    const installed = await until(
      () => accountPlugin(cloud, slug),
      Boolean,
      'The real UI install did not create account membership',
      30_000
    )
    const installedId = Number(installed.metadata.labels.id)
    await until(
      () => materializedPlugin(executorHome, installedId),
      Boolean,
      'The new installation did not reach the real local runtime',
      30_000
    )
    await assertInventory(control, slug, true)
    assert.ok(
      apiProxy.requests
        .slice(requestStart)
        .some(
          entry =>
            entry.method === 'POST' &&
            entry.path === `/api/plugins/marketplace/${item.pluginId}/install` &&
            entry.status === 200
        ),
      'The installation bypassed the real app API'
    )
    report.confirmedInstallation = { installedId, deviceId }
    await captureScreenshot(control, 'plugin-late-response-before-release.png', 'body')
    const releasedAt = Date.now()
    assert.equal(await delayedEntry.release(), true)
    assert.equal(delayedEntry.released, true)
    report.rendererCompletedOlderRead = await until(
      async () => {
        const timings = await completedApiResourceTimings(control, '/api/plugins/installed')
        const matches = timings.filter(
          timing =>
            timing.startedAt >= olderReadStartedAt - 100 &&
            timing.startedAt <= heldReadyAt &&
            timing.completedAt >= releasedAt
        )
        assert.ok(matches.length <= 1, 'Delayed response timing is ambiguous')
        return matches[0]
      },
      Boolean,
      'The renderer did not finish receiving the original delayed read'
    )
    await control.command('waitFor', testId('plugins-refresh-button'), {
      enabled: true,
      stableMs: 300,
    })
    await assertInventory(control, slug, true)
    const final = await accountPlugin(cloud, slug)
    assert.equal(Number(final.metadata.labels.id), installedId)
    assert.ok(await materializedPlugin(executorHome, installedId))
    await control.command('waitFor', testId(`plugin-marketplace-actions-${item.pluginId}`), {
      enabled: true,
    })
    report.final = {
      installedId,
      sharedInventoryContainsFixture: (
        await inventory(control)
      ).sharedInventory.installedPlugins.some(plugin => plugin.pluginKey === slug),
      originalReplyActuallyReleased: true,
    }
    await captureScreenshot(control, 'plugin-late-response-after-release.png', 'body')
    report.catalogDiskGeneration = { passed: false }
    await verifyCatalogDiskGeneration({
      control,
      executorHome,
      item: { ...item, installedId },
      apiProxy,
      deviceId,
      report: report.catalogDiskGeneration,
    })
    report.passed = true
    return report
  } catch (error) {
    report.error = String(error?.stack ?? error)
    throw error
  } finally {
    apiProxy.rule = () => null
    await delayedEntry?.release?.()
    report.elapsedMs = Date.now() - started
    report.requests = apiProxy.requests.slice(requestStart)
    await writeFile(
      join(resultDir, 'plugin-late-response-resilience-evidence.json'),
      JSON.stringify(report, null, 2)
    )
  }
}
