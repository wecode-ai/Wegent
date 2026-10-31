import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertInstallButton,
  assertInventory,
  installFixture,
  inventory,
  materializedPlugin,
  openPlugin,
  pluginApi,
  testId,
  uninstallInUi,
  until,
} from './plugin-regression-fixture.mjs'

const catalogPath = '/api/plugins/marketplace'
const installedPath = '/api/plugins/installed'
const fixturePrefix = 'catalog-boundary-'

/** Compare real source failures without substituting API responses or cache state. */
export async function verifyPluginCatalogBoundaries({
  cloud,
  control,
  apiProxy,
  captureScreenshot,
  workbenchReadyTimeoutMs,
  resultDir,
  deviceId,
  executorHome,
}) {
  const reportPath = join(resultDir, 'plugin-catalog-boundaries-evidence.json')
  const screenshots = []
  const failures = []
  const requestStart = apiProxy.requests.length
  const startedAt = Date.now()
  const report = {
    scope:
      'Real cloud catalog and installed-source transport failures and explicit refresh recovery',
    excluded: ['Codex partial inventory', 'local plugin detail failures'],
    preconditions: { completed: false },
    phases: [],
  }
  let installed
  let listing

  const requestsSince = index => apiProxy.requests.slice(index)
  const hasGet = (requests, path, predicate) =>
    requests.some(
      request => request.method === 'GET' && request.path === path && predicate(request)
    )
  const hasSuccess = (requests, path) =>
    hasGet(requests, path, request => request.status === 200 && !request.fault)
  const present = async selector =>
    Number(await control.command('getElementCount', selector, { visible: true })) > 0
  const row = fixture => testId(`plugin-marketplace-row-${fixture.pluginId}`)
  const installAction = fixture =>
    `button${testId(`plugin-marketplace-install-${fixture.pluginId}`)}:not(:disabled)`
  const installedAction = () =>
    `button${testId(`plugin-marketplace-actions-${installed.pluginId}`)}:not(:disabled)`

  async function openFixtures() {
    await openPlugin(control, { slug: fixturePrefix })
    await control.command('waitFor', testId('plugins-refresh-button'), { enabled: true })
  }

  async function refresh(path, failed = false) {
    const index = apiProxy.requests.length
    await control.command('waitFor', testId('plugins-refresh-button'), { enabled: true })
    await control.command('click', testId('plugins-refresh-button'))
    await until(
      () => requestsSince(index),
      requests =>
        failed
          ? hasGet(requests, path, request => request.fault === 'disconnect')
          : hasSuccess(requests, path),
      `Refresh did not ${failed ? 'reach the transport fault' : 'receive HTTP 200'} for ${path}`
    )
    await control.command('waitFor', testId('plugins-refresh-button'), {
      enabled: true,
      stableMs: 250,
    })
    return index
  }

  async function observe() {
    const state = await inventory(control)
    const containsInstalled = items => items.some(item => item.pluginKey === installed.slug)
    return {
      listingRow: await present(row(listing)),
      listingInstallEnabled: await present(installAction(listing)),
      installedRow: await present(row(installed)),
      installedActionsEnabled: await present(installedAction()),
      installedInstallEnabled: await present(installAction(installed)),
      errorNotice: await present(`${testId('plugin-operation-notice')}[data-notice-kind="error"]`),
      localMaterialized: Boolean(await materializedPlugin(executorHome, installed.installedId)),
      sharedInstalled: containsInstalled(state.sharedInventory.installedPlugins),
      composerInstalled: containsInstalled(state.composerApps),
    }
  }

  function check(phase, name, actual) {
    phase.assertions.push({ name, passed: actual === true })
    if (actual !== true) failures.push(new Error(`${phase.name}: ${name}`))
  }

  async function phase(name, run) {
    const phaseStarted = Date.now()
    const entry = { name, requestStart: apiProxy.requests.length, assertions: [] }
    report.phases.push(entry)
    try {
      await run(entry)
    } catch (error) {
      entry.executionError = String(error?.message ?? error)
      failures.push(new Error(`${name}: ${entry.executionError}`, { cause: error }))
    } finally {
      entry.elapsedMs = Date.now() - phaseStarted
      entry.requestEnd = apiProxy.requests.length
      entry.passed = !entry.executionError && entry.assertions.every(item => item.passed)
      const filename = `plugin-catalog-boundaries-${name}.png`
      try {
        await captureScreenshot(control, filename, 'body')
        screenshots.push(filename)
        entry.screenshot = filename
      } catch (error) {
        entry.screenshotError = String(error?.message ?? error)
        entry.passed = false
        failures.push(new Error(`${name}: screenshot capture failed`, { cause: error }))
      }
    }
  }

  async function faultAndRecover(name, failedPath, healthyPath) {
    try {
      await phase(`${name}-fault`, async entry => {
        await openFixtures()
        const index = apiProxy.requests.length
        apiProxy.rule = request =>
          request.method === 'GET' && request.path === failedPath ? 'disconnect' : null
        await refresh(failedPath, true)
        entry.observed = await observe()
        const requests = requestsSince(index)
        check(
          entry,
          'The selected source actually suffered a transport disconnect',
          hasGet(requests, failedPath, request => request.fault === 'disconnect')
        )
        check(
          entry,
          'The independent healthy cloud source returned HTTP 200',
          hasSuccess(requests, healthyPath)
        )
        check(
          entry,
          'The previously loaded uninstalled catalog row remains visible',
          entry.observed.listingRow
        )
        check(
          entry,
          'The uninstalled listing remains actionable',
          entry.observed.listingInstallEnabled
        )
        check(entry, 'The installed plugin remains visible', entry.observed.installedRow)
        check(
          entry,
          'The installed plugin actions remain enabled',
          entry.observed.installedActionsEnabled
        )
        check(
          entry,
          'The healthy managed device installation is retained',
          entry.observed.localMaterialized
        )
        check(entry, 'The shared installed inventory is retained', entry.observed.sharedInstalled)
        check(entry, 'The loaded composer projection is retained', entry.observed.composerInstalled)
        check(
          entry,
          'The existing error notice explains the source failure',
          entry.observed.errorNotice
        )
      })
    } finally {
      apiProxy.rule = () => null
    }
    await phase(`${name}-recovery`, async entry => {
      await openFixtures()
      const index = await refresh(failedPath)
      entry.observed = await observe()
      check(
        entry,
        'The recovered source returned a fresh real HTTP 200',
        hasSuccess(requestsSince(index), failedPath)
      )
      check(
        entry,
        'The catalog listing is visible and actionable',
        entry.observed.listingRow && entry.observed.listingInstallEnabled
      )
      check(
        entry,
        'The installed plugin is visible and actionable',
        entry.observed.installedRow && entry.observed.installedActionsEnabled
      )
      check(
        entry,
        'The recovered inventory still contains the installed plugin',
        entry.observed.sharedInstalled &&
          entry.observed.localMaterialized &&
          entry.observed.composerInstalled
      )
      check(
        entry,
        'A successful explicit refresh clears the error notice',
        !entry.observed.errorNotice
      )
    })
  }

  async function setListingsPublished(isListed) {
    for (const fixture of [installed, listing]) {
      const response = await fetch(
        `${cloud.backendUrl}/api/admin/marketplace-plugins/${fixture.pluginId}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${cloud.authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ is_listed: isListed }),
          signal: AbortSignal.timeout(10_000),
        }
      )
      assert.equal(response.status, 200, 'Real marketplace listing update failed')
    }
  }

  async function catalogBeforeMembership(entry) {
    const index = apiProxy.requests.length
    const originalRule = apiProxy.rule
    apiProxy.rule = request =>
      request.method === 'GET' && request.path === installedPath
        ? 'hold-response'
        : originalRule(request)
    try {
      listing = {
        ...(await cloud.publishPluginRelease({
          slug: `${fixturePrefix}listing`,
          version: '1.0.0',
        })),
        slug: `${fixturePrefix}listing`,
      }
      // This listing did not exist before the hold, so a warm row cannot mask
      // catalog loading that incorrectly waits for installed membership.
      await openPlugin(control, { slug: fixturePrefix })
      await until(
        () => requestsSince(index),
        requests =>
          hasSuccess(requests, catalogPath) &&
          hasGet(requests, installedPath, request => request.committedResponseHeld === true),
        'Catalog must return while the real installed response is held'
      )
      await control.command('waitFor', row(listing), { visible: true })
      const pending = requestsSince(index).filter(request => request.fault === 'hold-response')
      entry.observed = {
        listingRow: await present(row(listing)),
        heldInstalledResponses: pending.length,
        installedDelivered: pending.some(request => request.responseCompleted === true),
      }
      check(
        entry,
        'The new cloud catalog row appears before installed membership',
        entry.observed.listingRow
      )
      check(
        entry,
        'Installed membership is still pending',
        pending.length > 0 && !entry.observed.installedDelivered
      )
      entry.heldScreenshot = 'plugin-catalog-before-installed-membership.png'
      await captureScreenshot(control, entry.heldScreenshot, 'body')
    } finally {
      apiProxy.rule = originalRule
      // Freeze the finite request set after clearing the hold rule. Release the
      // original upstream bytes even when the early-row assertion fails.
      const pending = requestsSince(index).filter(request => request.fault === 'hold-response')
      await Promise.all(
        pending.map(async request => {
          await until(
            () => typeof request.release === 'function',
            Boolean,
            'The held installed response did not finish receiving from the real Backend'
          )
          assert.equal(await request.release(), true, 'Held installed membership was not delivered')
        })
      )
    }
  }

  try {
    assert.ok(deviceId, 'Catalog boundary fixtures need a real connected app device')
    const before = await pluginApi(cloud, '/plugins/marketplace')
    assert.ok(
      !before.items.some(item => item.name === `${fixturePrefix}listing`),
      'The progressive catalog fixture must not already exist'
    )
    await phase('catalog-before-installed-membership', catalogBeforeMembership)
    assert.ok(listing, 'The progressive cloud catalog fixture was not published')
    installed = await installFixture(
      cloud,
      control,
      `${fixturePrefix}installed`,
      deviceId,
      workbenchReadyTimeoutMs
    )
    const membership = await pluginApi(cloud, '/plugins/installed')
    assert.ok(membership.items.some(item => item.spec.source.pluginKey === installed.slug))
    assert.ok(!membership.items.some(item => item.spec.source.pluginKey === listing.slug))
    await openFixtures()
    await refresh(catalogPath)
    await control.command('waitFor', row(installed))
    await control.command('waitFor', row(listing))
    await assertInstallButton(control, listing)
    await control.command('waitFor', installedAction(), { enabled: true })
    await assertInventory(control, installed.slug, true)
    const prepared = await observe()
    assert.ok(
      prepared.localMaterialized,
      'The installed control fixture did not reach the managed device manifest'
    )
    assert.ok(!prepared.errorNotice, 'The real baseline fixture could not load without errors')
    const preparedScreenshot = 'plugin-catalog-boundaries-prepared.png'
    await captureScreenshot(control, preparedScreenshot, 'body')
    screenshots.push(preparedScreenshot)
    report.preconditions = {
      completed: true,
      installedSlug: installed.slug,
      installedId: installed.installedId,
      listingSlug: listing.slug,
      listingId: listing.pluginId,
      accountInstalledCount: membership.items.length,
      observed: prepared,
      screenshot: preparedScreenshot,
      elapsedMs: Date.now() - startedAt,
    }

    await faultAndRecover('catalog-source', catalogPath, installedPath)
    await faultAndRecover('installed-source', installedPath, catalogPath)

    await phase('successful-membership-removal', async entry => {
      await uninstallInUi(control, installed)
      await assertInstallButton(control, installed)
      await assertInventory(control, installed.slug, false)
      const response = await pluginApi(cloud, '/plugins/installed')
      entry.source = {
        status: 200,
        installedCount: response.items.length,
        successfulEmptyList: response.items.length === 0,
      }
      check(
        entry,
        'The real account source confirms the fixture was removed',
        !response.items.some(item => item.spec.source.pluginKey === installed.slug)
      )
      await openFixtures()
      const index = await refresh(installedPath)
      entry.observed = await observe()
      check(
        entry,
        'The successful installed source was refreshed through the app',
        hasSuccess(requestsSince(index), installedPath)
      )
      check(
        entry,
        'The removed fixture remains available for a fresh install',
        entry.observed.installedRow && entry.observed.installedInstallEnabled
      )
      check(
        entry,
        'The separate uninstalled catalog listing is unchanged',
        entry.observed.listingRow && entry.observed.listingInstallEnabled
      )
      check(
        entry,
        'The removed membership is absent from shared inventory',
        !entry.observed.sharedInstalled && !entry.observed.composerInstalled
      )
      check(
        entry,
        'A successful response is not reported as a source failure',
        !entry.observed.errorNotice
      )
    })

    try {
      await phase('successful-empty-catalog', async entry => {
        await setListingsPublished(false)
        const response = await pluginApi(cloud, '/plugins/marketplace')
        assert.equal(response.items.length, 0, 'The real source did not become an empty catalog')
        entry.source = { status: 200, catalogCount: response.items.length }
        // A manual refresh also runs reconciliation, which already repaired this
        // case before the optimization. Exercise ordinary page loading instead.
        await control.command('click', testId('plugins-manage-button'))
        await control.command(
          'waitFor',
          `${testId('plugin-management-installed-list')}, ${testId('plugin-management-empty-state')}`
        )
        const index = apiProxy.requests.length
        await openFixtures()
        await until(
          () => requestsSince(index),
          requests => hasSuccess(requests, catalogPath),
          'Reopening the marketplace did not load the real empty catalog'
        )
        await control.command('waitFor', testId('plugins-refresh-button'), {
          enabled: true,
          stableMs: 250,
        })
        check(
          entry,
          'The successful empty catalog was loaded automatically through the app',
          hasSuccess(requestsSince(index), catalogPath)
        )
        try {
          // Background refresh may keep the toolbar enabled. Await the actual
          // user-visible result so a transient warm paint cannot produce a red.
          await control.command('waitFor', `${row(listing)}, ${row(installed)}`, {
            visible: false,
            stableMs: 250,
          })
        } finally {
          entry.observed = await observe()
        }
        check(
          entry,
          'The unpublished catalog-only row is removed instead of retained from cache',
          !entry.observed.listingRow && !entry.observed.listingInstallEnabled
        )
        check(
          entry,
          'The unpublished former installation is removed from the catalog',
          !entry.observed.installedRow && !entry.observed.installedInstallEnabled
        )
        check(
          entry,
          'A successful empty catalog is not reported as a source failure',
          !entry.observed.errorNotice
        )
        check(
          entry,
          'Refreshing an empty catalog does not revive the removed installation',
          !entry.observed.localMaterialized &&
            !entry.observed.sharedInstalled &&
            !entry.observed.composerInstalled
        )
      })
    } finally {
      await setListingsPublished(true)
    }

    await phase('catalog-republication-recovery', async entry => {
      const source = await pluginApi(cloud, '/plugins/marketplace')
      assert.equal(source.items.length, 2, 'Both real listings must be published again')
      entry.source = { status: 200, catalogCount: source.items.length }
      await openFixtures()
      const index = await refresh(catalogPath)
      entry.observed = await observe()
      check(
        entry,
        'The republished catalog was refreshed through the app',
        hasSuccess(requestsSince(index), catalogPath)
      )
      check(
        entry,
        'The republished listing is visible and installable again',
        entry.observed.listingRow && entry.observed.listingInstallEnabled
      )
      check(
        entry,
        'The former installation remains available for an explicit new install',
        entry.observed.installedRow && entry.observed.installedInstallEnabled
      )
      check(
        entry,
        'Republication does not recreate account or device installation membership',
        !entry.observed.localMaterialized &&
          !entry.observed.sharedInstalled &&
          !entry.observed.composerInstalled
      )
      check(entry, 'Republication refresh clears source errors', !entry.observed.errorNotice)
    })
  } catch (error) {
    report.setupError = String(error?.message ?? error)
    throw error
  } finally {
    apiProxy.rule = () => null
    report.elapsedMs = Date.now() - startedAt
    report.requestStart = requestStart
    report.requestEnd = apiProxy.requests.length
    report.requests = requestsSince(requestStart)
    report.passed = report.preconditions.completed && failures.length === 0 && !report.setupError
    await writeFile(reportPath, JSON.stringify(report, null, 2))
  }

  if (failures.length)
    throw new AggregateError(failures, 'Plugin catalog boundary assertions failed')
  return { reportPath, screenshots }
}
