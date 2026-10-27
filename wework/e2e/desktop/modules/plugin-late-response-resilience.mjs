import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
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

function jsonResponse(delayed) {
  const encoding = delayed.headers['content-encoding']
  const decoders = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync }
  assert.ok(!encoding || decoders[encoding], 'Unexpected real response encoding')
  const bytes = encoding ? decoders[encoding](delayed.body) : delayed.body
  return JSON.parse(bytes.toString('utf8'))
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
    scope: 'An older installed-list response arrives after a real UI installation',
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
