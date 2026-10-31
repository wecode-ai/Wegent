import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  materializedPlugin,
  openPlugin,
  pluginApi,
  testId,
  until,
} from './plugin-regression-fixture.mjs'

const skillName = 'resilience-check'
const prefix = 'install-update-resilience-'
const packageFailureCode = 'PLUGIN_PACKAGE_INTEGRITY_FAILED'

function within(root, path) {
  const child = relative(root, path)
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

function skillBytes(marker) {
  return Buffer.from(`---\nname: ${skillName}\ndescription: ${marker}\n---\n\n${marker}\n`)
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Fail publication at an isolated, previously absent content-addressed package. */
async function blockPackage(sharedRoot, release) {
  assert.match(release.sha256, /^[a-f0-9]{64}$/)
  assert.equal(await realpath(sharedRoot), sharedRoot, 'Shared package parent must be canonical')
  const target = join(sharedRoot, release.sha256)
  assert.equal(dirname(target), sharedRoot)
  await assert.rejects(lstat(target), { code: 'ENOENT' })
  const bytes = Buffer.from(`Desktop E2E package publication fault ${randomUUID()}\n`)
  const handle = await open(target, 'wx', 0o600)
  let identity
  try {
    await handle.writeFile(bytes)
    identity = await handle.stat()
    assert.ok(identity.isFile() && !identity.isSymbolicLink())
  } finally {
    await handle.close()
  }
  const verify = async () => {
    assert.equal(await realpath(sharedRoot), sharedRoot)
    const current = await lstat(target)
    assert.ok(current.isFile() && !current.isSymbolicLink(), 'Fault target changed type')
    assert.equal(current.dev, identity.dev, 'Fault target changed device')
    assert.equal(current.ino, identity.ino, 'Fault target changed identity')
    assert.deepEqual(await readFile(target), bytes, 'Fault target changed contents')
  }
  return {
    target,
    async verify() {
      await verify()
      return { target, sha256: digest(bytes), kind: 'exclusive-regular-file' }
    },
    async release() {
      await verify()
      await unlink(target)
    },
  }
}

/** Real publication, account APIs, device sync, runtime files and desktop UI. */
export async function verifyPluginInstallUpdateResilience({
  cloud,
  control,
  apiProxy,
  deviceId,
  executorHome,
  resultDir,
  captureScreenshot,
  workbenchReadyTimeoutMs,
}) {
  const startedAt = Date.now()
  const requestStart = apiProxy.requests.length
  const failures = []
  const report = {
    scope: 'Cloud plugin install/update transport faults and real package publication failures',
    preconditions: { completed: false },
    releases: [],
    cases: [],
  }
  const reportPath = join(resultDir, 'plugin-install-update-resilience-evidence.json')
  const timeoutMs = Math.min(workbenchReadyTimeoutMs, 30_000)
  let sharedRoot
  let healthy

  const requests = (index, method, path) =>
    apiProxy.requests
      .slice(index)
      .filter(request => request.method === method && request.path === path)
  const errorNotice = `${testId('plugin-operation-notice')}[data-notice-kind="error"]`
  const installButton = item =>
    `button${testId(`plugin-marketplace-install-${item.pluginId}`)}:not(:disabled)`

  function logicalRequestIds(attempts) {
    assert.ok(attempts.length > 0, 'The UI operation made no real transport attempt')
    for (const attempt of attempts) {
      assert.match(attempt.requestIdFingerprint, /^[a-f0-9]{64}$/)
    }
    return [...new Set(attempts.map(attempt => attempt.requestIdFingerprint))]
  }

  function failedRequest(attempts) {
    const ids = logicalRequestIds(attempts)
    assert.equal(ids.length, 1, 'One user operation created multiple logical requests')
    assert.ok(
      attempts.every(attempt => attempt.fault === 'disconnect' && attempt.status === undefined),
      'Every failed transport attempt must be disconnected before reaching the backend'
    )
    return { requestIdFingerprint: ids[0], transportAttempts: attempts.length }
  }

  async function explicitRetry(readAttempts, failed) {
    await until(
      readAttempts,
      attempts =>
        attempts.some(
          attempt =>
            attempt.requestIdFingerprint !== failed.requestIdFingerprint &&
            attempt.status === 200 &&
            attempt.responseCompleted === true &&
            !attempt.fault
        ),
      'The fresh logical user retry did not complete its real backend response',
      timeoutMs
    )
    const attempts = readAttempts()
    const ids = logicalRequestIds(attempts)
    assert.equal(ids.length, 2, 'One explicit user retry must create one fresh logical request')
    const retryId = ids.find(id => id !== failed.requestIdFingerprint)
    const retryAttempts = attempts.filter(attempt => attempt.requestIdFingerprint === retryId)
    assert.ok(
      retryAttempts.some(
        attempt => attempt.status === 200 && attempt.responseCompleted === true && !attempt.fault
      ),
      'The fresh logical user retry did not receive a real successful backend response'
    )
    assert.ok(
      attempts
        .filter(attempt => attempt.requestIdFingerprint === failed.requestIdFingerprint)
        .every(attempt => attempt.fault === 'disconnect' && attempt.status === undefined),
      'A settled failed request was replayed after the user retry'
    )
    return {
      requestIdFingerprint: retryId,
      transportAttempts: retryAttempts.length,
      responseCompleted: true,
    }
  }

  async function request(path, method, body) {
    const response = await fetch(`${cloud.backendUrl}/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cloud.authToken}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
    assert.ok(response.ok, `${method} ${path.split('?')[0]}: HTTP ${response.status}`)
    return response.status === 204 ? null : response.json()
  }

  async function membership(item) {
    const response = await pluginApi(
      cloud,
      `/plugins/installed?device_id=${encodeURIComponent(deviceId)}`
    )
    const matching = response.items.filter(plugin => plugin.spec.source.pluginKey === item.slug)
    assert.ok(matching.length <= 1, `Duplicate account memberships for ${item.slug}`)
    return matching[0] ?? null
  }

  async function observe(item) {
    const account = await membership(item)
    if (!account) return { account: null, runtime: null }
    const id = Number(account.metadata.labels.id)
    const runtime = await materializedPlugin(executorHome, id)
    const device = account.status.devices?.find(row => row.deviceId === deviceId) ?? null
    let materialized = null
    let runtimeFilePending = false
    if (runtime) {
      try {
        const root = resolve(executorHome, 'capabilities', runtime.runtime.codex_link)
        const canonical = await realpath(root)
        assert.ok(within(await realpath(resultDir), canonical), 'Runtime escaped isolated E2E root')
        const manifest = JSON.parse(
          await readFile(join(canonical, '.codex-plugin/plugin.json'), 'utf8')
        )
        const bytes = await readFile(join(canonical, 'skills', skillName, 'SKILL.md'))
        materialized = {
          root: canonical,
          storePath: runtime.store_path,
          version: manifest.version,
          skillSha256: digest(bytes),
          skillBytesBase64: bytes.toString('base64'),
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        runtimeFilePending = true
      }
    }
    return {
      account: {
        id,
        version: account.spec.version,
        releaseId: account.spec.releaseId,
        updatePolicy: account.spec.updatePolicy,
        device,
      },
      runtime: materialized,
      runtimeFilePending,
    }
  }

  function assertRuntime(state, release) {
    assert.equal(state.runtime?.version, release.version, 'Wrong active runtime version')
    assert.equal(state.runtime?.skillBytesBase64, skillBytes(release.marker).toString('base64'))
  }

  async function awaitInstalled(item, release = item) {
    const state = await until(
      () => observe(item),
      state =>
        state.account?.device?.state === 'installed' &&
        state.account.device.actualReleaseId === release.releaseId &&
        state.account.device.desiredReleaseId === release.releaseId &&
        state.runtime?.version === release.version,
      `${item.slug} did not activate release ${release.releaseId}`,
      timeoutMs
    )
    assert.equal(state.account.releaseId, release.releaseId)
    assert.equal(state.account.version, release.version)
    assertRuntime(state, release)
    return state
  }

  async function assertUnique(item, expectedId, { includeInactive = false } = {}) {
    const rows = await cloud.queryDatabase(
      'SELECT id FROM kinds WHERE user_id = %s AND kind = %s AND namespace = %s' +
        (includeInactive ? '' : ' AND is_active = 1') +
        ' AND JSON_UNQUOTE(JSON_EXTRACT(`json`, %s)) = %s',
      [1, 'InstalledPlugin', 'default', '$.spec.source.pluginKey', item.slug]
    )
    assert.equal(
      rows.length,
      1,
      includeInactive
        ? 'A repeated install created another account row, including inactive rows'
        : 'A retry created another active account installation'
    )
    assert.equal(Number(rows[0].id), expectedId, 'A retry replaced the cloud installation identity')
    return rows.map(row => Number(row.id))
  }

  async function refresh(item) {
    const back = testId('plugin-detail-back-button')
    if (Number(await control.command('getElementCount', back, { visible: true })) > 0) {
      await control.command('click', back)
    }
    await openPlugin(control, item)
    await control.command('clickWhenEnabled', testId('plugins-refresh-button'))
    await control.command('waitFor', testId('plugins-refresh-button'), {
      enabled: true,
      stableMs: 250,
    })
    await control.command('waitFor', testId(`plugin-marketplace-row-${item.pluginId}`))
  }

  async function dismissNotice() {
    const selector = testId('plugin-operation-notice-dismiss')
    if (Number(await control.command('getElementCount', selector, { visible: true })) > 0) {
      await control.command('click', selector)
    }
  }

  async function installUi(item, confirm = true) {
    await refresh(item)
    await dismissNotice()
    await control.command('clickWhenEnabled', installButton(item))
    await control.command('waitFor', testId('install-plugin-dialog-confirm'))
    if (confirm) {
      await control.command('clickWhenEnabled', testId('install-plugin-dialog-confirm'))
    }
  }

  async function openDetail(item) {
    await refresh(item)
    await control.command('click', testId(`plugin-marketplace-row-${item.pluginId}`))
    await control.command('waitFor', '[data-testid^="plugin-detail-toggle-"]')
  }

  async function updateUi(item, confirm = true) {
    await openDetail(item)
    await dismissNotice()
    await until(
      () => control.command('getText', '[data-testid^="plugin-detail-toggle-"]'),
      text => /更新|Update|重试|Retry/.test(text),
      'Real marketplace detail did not offer an update'
    )
    await control.command('clickWhenEnabled', '[data-testid^="plugin-detail-toggle-"]')
    await control.command('waitFor', testId('plugin-update-confirm-button'))
    if (confirm) {
      await control.command('clickWhenEnabled', testId('plugin-update-confirm-button'))
    }
  }

  async function visibleUpgradeFailure(item) {
    await openDetail(item)
    const header = 'header:has([data-testid="plugin-detail-logo"])'
    await control.command('waitFor', header, { text: '失败' })
    const headerText = await control.command('getText', header)
    assert.ok(headerText.includes(item.slug), 'Failure summary belongs to another plugin')
    assert.match(headerText, /[1-9]\d* 失败/, 'The device failure is not visible in the detail')
    const action = '[data-testid^="plugin-detail-toggle-"]'
    await control.command('waitFor', action, { enabled: true })
    const actionText = await control.command('getText', action)
    assert.match(actionText, /更新|Update/, 'A failed upgrade must retain an enabled update action')
    return { headerText, actionText }
  }

  async function setPolicy(item, policy, ui = false) {
    const account = await membership(item)
    assert.ok(account)
    const id = Number(account.metadata.labels.id)
    if (ui) {
      await openDetail(item)
      const selector = testId(`plugin-auto-update-toggle-${id}`)
      await control.command('waitFor', selector, { enabled: true })
      assert.notEqual(account.spec.updatePolicy, policy)
      await control.command('clickWhenEnabled', selector)
    } else {
      await request(`/plugins/installed/${id}?device_id=${encodeURIComponent(deviceId)}`, 'PUT', {
        updatePolicy: policy,
      })
    }
    await until(
      () => membership(item),
      value => value?.spec.updatePolicy === policy,
      `${item.slug} did not save ${policy} update policy`,
      timeoutMs
    )
  }

  async function publish(suffix, version = '1.0.0') {
    const slug = `${prefix}${suffix}`
    const marker = `${slug} real release ${version}`
    const release = {
      ...(await cloud.publishPluginRelease({
        slug,
        version,
        skills: { [skillName]: marker },
      })),
      slug,
      version,
      marker,
    }
    report.releases.push(release)
    return release
  }

  async function prepareUpgrade(suffix) {
    const old = await publish(suffix)
    await installUi(old)
    const before = await awaitInstalled(old)
    await setPolicy(old, 'manual')
    const next = await publish(suffix, '2.0.0')
    assert.equal(next.pluginId, old.pluginId, 'Versions must belong to the same real listing')
    assert.notEqual(next.releaseId, old.releaseId)
    return { old, next, before }
  }

  async function healthyContinues(entry) {
    await refresh(healthy)
    await control.command('waitFor', testId(`plugin-marketplace-actions-${healthy.pluginId}`), {
      enabled: true,
    })
    entry.healthy = await awaitInstalled(healthy)
    assert.equal(entry.healthy.account.id, healthy.installedId)
  }

  async function captureFault(entry) {
    const screenshot = `plugin-install-update-${entry.name}-fault.png`
    await captureScreenshot(control, screenshot, 'body')
    entry.faultScreenshot = screenshot
  }

  async function failedPackage(item, desired, previous) {
    const state = await until(
      () => observe(item),
      state =>
        state.account?.device?.state === 'failed' &&
        !state.runtimeFilePending &&
        state.account.device.desiredReleaseId === desired.releaseId &&
        state.account.device.errorCode === packageFailureCode,
      `${item.slug} did not report the real package-stage failure`,
      timeoutMs
    )
    assert.equal(state.account.releaseId, desired.releaseId)
    assert.ok(state.account.device.errorMessage, 'Package failure must retain a real error')
    assert.ok(state.account.device.attemptCount > 0)
    if (previous) {
      assert.equal(state.account.device.actualReleaseId, previous.releaseId)
      assertRuntime(state, previous)
    } else {
      assert.ok(!state.account.device.actualReleaseId)
      assert.equal(state.runtime, null, 'Failed first install activated a partial runtime')
    }
    return state
  }

  async function runCase(name, run) {
    const entry = { name, requestStart: apiProxy.requests.length, passed: false }
    report.cases.push(entry)
    const start = Date.now()
    try {
      await run(entry)
      entry.passed = true
    } catch (error) {
      entry.error = String(error?.stack ?? error)
      failures.push(new Error(`${name}: ${error?.message ?? error}`, { cause: error }))
    } finally {
      apiProxy.rule = () => null
      entry.elapsedMs = Date.now() - start
      entry.requests = apiProxy.requests.slice(entry.requestStart)
      const screenshot = `plugin-install-update-${name}.png`
      try {
        await captureScreenshot(control, screenshot, 'body')
        entry.screenshot = screenshot
      } catch (error) {
        entry.passed = false
        entry.screenshotError = String(error?.message ?? error)
        failures.push(new Error(`${name}: screenshot failed`, { cause: error }))
      }
      await writeFile(reportPath, JSON.stringify(report, null, 2))
      for (const id of [
        'install-plugin-dialog-cancel',
        'plugin-update-confirm-button-cancel-button',
      ]) {
        const selector = testId(id)
        if (Number(await control.command('getElementCount', selector, { visible: true })) > 0) {
          await control.command('click', selector)
        }
      }
    }
  }

  try {
    assert.ok(deviceId, 'A real connected app device is required')
    healthy = await publish('healthy')
    await installUi(healthy)
    const healthyState = await awaitInstalled(healthy)
    healthy.installedId = healthyState.account.id
    await setPolicy(healthy, 'manual')
    const isolatedRoot = await realpath(resultDir)
    let parent = isolatedRoot
    for (const component of ['home', '.wegent', 'workbench', 'shared', 'plugins']) {
      parent = join(parent, component)
      const metadata = await lstat(parent)
      assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink())
      assert.equal(await realpath(parent), parent)
    }
    sharedRoot = parent
    assert.ok(within(isolatedRoot, sharedRoot))
    const expectedStore = join(sharedRoot, healthy.sha256)
    assert.equal(await realpath(healthyState.runtime.storePath), expectedStore)
    report.preconditions = {
      completed: true,
      deviceId,
      sharedRoot,
      healthy: healthyState,
    }

    await runCase('install-disconnect-and-explicit-retry', async entry => {
      const item = await publish('post-disconnect')
      const path = `/api/plugins/marketplace/${item.pluginId}/install`
      const start = apiProxy.requests.length
      apiProxy.rule = request =>
        request.method === 'POST' && request.path === path ? 'disconnect' : null
      await installUi(item)
      await control.command('waitFor', errorNotice)
      await control.command('waitFor', installButton(item), { enabled: true })
      entry.failedRequest = failedRequest(requests(start, 'POST', path))
      entry.failed = await observe(item)
      assert.equal(entry.failed.account, null, 'Disconnected install reached the backend')
      await captureFault(entry)
      await healthyContinues(entry)
      apiProxy.rule = () => null
      await installUi(item)
      entry.recovered = await awaitInstalled(item)
      entry.retryRequest = await explicitRetry(
        () => requests(start, 'POST', path),
        entry.failedRequest
      )
      entry.activeIds = await assertUnique(item, entry.recovered.account.id)
    })

    await runCase('manual-update-disconnect-and-explicit-retry', async entry => {
      const { old, next, before } = await prepareUpgrade('put-disconnect')
      entry.before = before
      const path = `/api/plugins/installed/${before.account.id}`
      const start = apiProxy.requests.length
      apiProxy.rule = request =>
        request.method === 'PUT' && request.path === path ? 'disconnect' : null
      await updateUi(old)
      await control.command('waitFor', errorNotice)
      await control.command('waitFor', '[data-testid^="plugin-detail-toggle-"]', { enabled: true })
      entry.failedRequest = failedRequest(requests(start, 'PUT', path))
      entry.failed = await awaitInstalled(old)
      assert.equal(entry.failed.account.id, before.account.id)
      await captureFault(entry)
      await healthyContinues(entry)
      apiProxy.rule = () => null
      await updateUi(old)
      entry.recovered = await awaitInstalled(old, next)
      entry.retryRequest = await explicitRetry(
        () => requests(start, 'PUT', path),
        entry.failedRequest
      )
      entry.activeIds = await assertUnique(old, before.account.id)
    })

    await runCase('committed-install-response-dropped', async entry => {
      const item = await publish('committed-post')
      const path = `/api/plugins/marketplace/${item.pluginId}/install`
      const start = apiProxy.requests.length
      apiProxy.rule = request =>
        request.method === 'POST' && request.path === path ? 'drop-response' : null
      await installUi(item)
      await until(
        () => requests(start, 'POST', path),
        values => values.some(value => value.status === 200 && value.committedResponseDropped),
        'The real backend response was not committed and dropped',
        timeoutMs
      )
      await control.command('waitFor', errorNotice)
      const dropped = requests(start, 'POST', path)
      entry.droppedRequestIds = logicalRequestIds(dropped)
      assert.equal(entry.droppedRequestIds.length, 1, 'The failed UI operation was restarted')
      assert.ok(
        dropped.every(attempt => attempt.status === 200 && attempt.committedResponseDropped),
        'Every transport attempt must commit a real response before it is dropped'
      )
      entry.droppedTransportAttempts = dropped.length
      entry.committed = await awaitInstalled(item)
      await captureFault(entry)
      await healthyContinues(entry)
      apiProxy.rule = () => null
      await refresh(item)
      await control.command('waitFor', testId(`plugin-marketplace-actions-${item.pluginId}`), {
        enabled: true,
      })
      entry.recovered = await awaitInstalled(item)
      assert.equal(entry.recovered.account.id, entry.committed.account.id)
      assert.deepEqual(
        logicalRequestIds(requests(start, 'POST', path)),
        entry.droppedRequestIds,
        'Refresh created another logical install request'
      )
      entry.activeIds = await assertUnique(item, entry.committed.account.id)
      entry.allInstallationIds = await assertUnique(item, entry.committed.account.id, {
        includeInactive: true,
      })
    })

    await runCase('first-install-package-failure-and-explicit-retry', async entry => {
      const item = await publish('first-package')
      const fault = await blockPackage(sharedRoot, item)
      try {
        entry.fault = await fault.verify()
        await installUi(item)
        entry.failed = await failedPackage(item, item)
        await control.command('waitFor', errorNotice)
        await captureFault(entry)
        await healthyContinues(entry)
        await fault.verify()
        // Prepare the user retry while publication is still blocked. Refreshing
        // after removing the fault could repair the device before the click.
        await installUi(item, false)
      } finally {
        await fault.release()
      }
      const previousId = entry.failed.account.id
      await control.command('clickWhenEnabled', testId('install-plugin-dialog-confirm'))
      entry.recovered = await awaitInstalled(item)
      entry.activeIds = await assertUnique(item, previousId)
    })

    await runCase('manual-update-package-failure-preserves-old-runtime', async entry => {
      const { old, next, before } = await prepareUpgrade('manual-package')
      entry.before = before
      const fault = await blockPackage(sharedRoot, next)
      try {
        entry.fault = await fault.verify()
        await updateUi(old)
        entry.failed = await failedPackage(old, next, old)
        assert.equal(entry.failed.runtime.root, before.runtime.root)
        entry.visibleFailure = await visibleUpgradeFailure(old)
        await captureFault(entry)
        await healthyContinues(entry)
        await fault.verify()
        await updateUi(old, false)
      } finally {
        await fault.release()
      }
      await control.command('clickWhenEnabled', testId('plugin-update-confirm-button'))
      entry.recovered = await awaitInstalled(old, next)
      entry.activeIds = await assertUnique(old, before.account.id)
    })

    await runCase('auto-update-failed-plugin-does-not-block-next', async entry => {
      const bad = await prepareUpgrade('auto-bad')
      const good = await prepareUpgrade('auto-good')
      entry.before = { failedPlugin: bad.before, healthyPlugin: good.before }
      assert.ok(bad.before.account.id < good.before.account.id, 'Failed plugin must sort first')
      const fault = await blockPackage(sharedRoot, bad.next)
      try {
        entry.fault = await fault.verify()
        // Both new releases were published while manual. Configure candidates
        // away from the plugin page and observe actual per-plugin request order.
        await control.command('click', testId('new-chat-button'))
        entry.autoRequestStart = apiProxy.requests.length
        await setPolicy(bad.old, 'auto')
        await setPolicy(good.old, 'auto')
        await refresh(good.old)
        entry.failed = await failedPackage(bad.old, bad.next, bad.old)
        entry.healthyUpdated = await awaitInstalled(good.old, good.next)
        const passRequests = apiProxy.requests.slice(entry.autoRequestStart)
        const syncIndex = id =>
          passRequests.findIndex(
            request =>
              request.method === 'POST' &&
              request.path === `/api/plugins/installed/${id}/sync-device` &&
              request.status === 200
          )
        entry.syncOrder = {
          failedPlugin: syncIndex(bad.before.account.id),
          healthyPlugin: syncIndex(good.before.account.id),
        }
        assert.ok(entry.syncOrder.failedPlugin >= 0, 'Failed plugin was not actually synchronized')
        assert.ok(
          entry.syncOrder.healthyPlugin > entry.syncOrder.failedPlugin,
          'Healthy plugin must actually synchronize after the failed plugin'
        )
        entry.visibleFailure = await visibleUpgradeFailure(bad.old)
        await captureFault(entry)
        assert.ok(
          apiProxy.requests
            .slice(entry.requestStart)
            .some(
              request =>
                request.method === 'POST' &&
                request.path === '/api/plugins/installed/auto-update-batch'
            ),
          'Automatic update did not use the real batch API'
        )
        assert.ok(
          apiProxy.requests
            .slice(entry.requestStart)
            .some(
              request =>
                request.method === 'POST' &&
                request.path === `/api/plugins/installed/${good.before.account.id}/sync-device` &&
                request.status === 200
            ),
          'Healthy plugin did not complete its real per-plugin synchronization'
        )
        await healthyContinues(entry)
        await fault.verify()
        await setPolicy(bad.old, 'manual', true)
        await updateUi(bad.old, false)
      } finally {
        await fault.release()
      }
      await control.command('clickWhenEnabled', testId('plugin-update-confirm-button'))
      entry.recovered = await awaitInstalled(bad.old, bad.next)
      entry.activeIds = await assertUnique(bad.old, bad.before.account.id)
      await awaitInstalled(good.old, good.next)
    })
    // Restore the catalog state expected by the following checkpoint fixtures.
    await control.command('click', testId('plugin-detail-back-button'))
    await control.command('waitFor', testId('plugins-search-input'))
    report.catalogReady = true
  } catch (error) {
    report.preconditionError = String(error?.stack ?? error)
    failures.push(error)
  } finally {
    apiProxy.rule = () => null
    report.elapsedMs = Date.now() - startedAt
    report.requests = apiProxy.requests.slice(requestStart)
    report.failures = failures.map(error => String(error?.message ?? error))
    report.passed =
      report.preconditions.completed && report.cases.length === 6 && failures.length === 0
    await writeFile(reportPath, JSON.stringify(report, null, 2))
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Plugin install/update resilience assertions failed')
  }
  assert.equal(report.cases.length, 6, 'Every install/update resilience case must run')
  return report
}
