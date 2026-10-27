import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  installFixture,
  materializedPlugin,
  openPlugin,
  pluginApi,
  requestPluginExecutor,
  testId,
  until,
} from './plugin-regression-fixture.mjs'

const slug = 'partial-inventory-resilience'
const skill = 'partial-inventory-check'
const cacheKey = 'wework.plugins.codexCatalog.v1'
const hash = value => createHash('sha256').update(value).digest('hex')
const row = item => testId(`plugin-marketplace-row-${item.pluginId}`)
const mutation = request =>
  request.method === 'POST' &&
  (/^\/api\/plugins\/installed\/(?:auto-update-batch|sync-device|report-device)$/.test(
    request.path
  ) ||
    /^\/api\/plugins\/installed\/\d+\/sync-device$/.test(request.path))

function within(root, target) {
  const suffix = relative(root, target)
  return suffix && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`)
}

/** A real incomplete local source must never authorize cloud inventory mutations. */
export async function verifyPluginPartialInventoryResilience({
  cloud,
  control,
  apiProxy,
  deviceId,
  executorHome,
  resultDir,
  captureScreenshot,
  workbenchReadyTimeoutMs,
}) {
  const reportPath = join(resultDir, 'plugin-partial-inventory-resilience-evidence.json')
  const report = {
    scope: 'Partial live local inventory blocks automatic updates, sync and manual repair',
    preconditions: { completed: false },
    faultChecks: [],
    snapshots: [],
    idleDiagnostics: [],
  }
  const startedAt = Date.now()
  const requestStart = apiProxy.requests.length
  const timeoutMs = Math.min(workbenchReadyTimeoutMs, 30_000)
  const root = await realpath(resultDir)
  let manifestPath
  let original
  let injected
  let mode
  let faultActive = false
  let faultRequestStart
  let faultStartedAt
  let fixture
  let next
  let failure
  let lastIdleFingerprint

  async function membership(observation) {
    const response = await pluginApi(
      cloud,
      `/plugins/installed?device_id=${encodeURIComponent(deviceId)}`
    )
    const matching = response.items.filter(plugin => plugin.spec.source.pluginKey === slug)
    const plugin = matching[0] ?? null
    observation.lastObserved = {
      at: Date.now(),
      requestedDeviceId: deviceId,
      matchingCount: matching.length,
      installedId: plugin?.metadata.labels.id ?? null,
      updatePolicy: plugin?.spec.updatePolicy ?? null,
      releaseId: plugin?.spec.releaseId ?? null,
      version: plugin?.spec.version ?? null,
      installState: plugin?.spec.installState ?? null,
      devices: (plugin?.status.devices ?? []).map(device => ({
        deviceId: device.deviceId,
        state: device.state,
        actualReleaseId: device.actualReleaseId,
        desiredReleaseId: device.desiredReleaseId,
        errorCode: device.errorCode,
        lastSyncAt: device.lastSyncAt,
      })),
    }
    assert.ok(matching.length <= 1, `Duplicate account memberships for ${slug}`)
    return plugin
  }

  async function replaceManifest(bytes) {
    assert.ok(within(root, manifestPath), 'Manifest replacement escaped the isolated run')
    const staging = `${manifestPath}.partial-inventory-${randomUUID()}.tmp`
    const handle = await open(staging, 'wx', mode)
    try {
      await handle.writeFile(bytes)
      await handle.close()
      await rename(staging, manifestPath)
    } finally {
      await handle.close()
      await rm(staging, { force: true })
    }
  }

  async function executor(method, expectedStatus = 200) {
    const { status, payload } = await requestPluginExecutor(control, method)
    assert.equal(status, expectedStatus, `Unexpected real Executor ${method} status`)
    return payload
  }

  async function checkFault(label) {
    const metadata = await lstat(manifestPath)
    assert.ok(metadata.isFile() && !metadata.isSymbolicLink())
    assert.equal(metadata.nlink, 1)
    assert.ok((await readFile(manifestPath)).equals(injected), 'The source fault was repaired')
    const store = await executor('executor.plugins.store.list', 500)
    assert.equal(store.ok, false)
    assert.equal(store.error?.code, 'plugin_store_list_failed')
    assert.match(store.error?.message ?? '', /missing plugins/)
    const config = await executor('executor.codex_home.config.read')
    assert.equal(config.ok, true, 'The separate Codex configuration source must stay healthy')
    report.faultChecks.push({
      label,
      at: Date.now(),
      manifestSha256: hash(injected),
      storeRejected: true,
      errorCode: store.error.code,
      independentConfigHealthy: true,
    })
  }

  async function snapshot(partial, since) {
    const raw = await control.command('getLocalStorageItem', 'body', { value: cacheKey })
    const store = raw ? JSON.parse(raw) : { entries: {} }
    const entries = Object.values(store.entries ?? {})
      .filter(
        entry =>
          entry.state?.deviceId === deviceId &&
          entry.cachedAt >= since &&
          entry.paramsKey.endsWith('|local')
      )
      .sort((left, right) => right.cachedAt - left.cachedAt)
    const matching = entries.find(entry => Boolean(entry.state.partial) === partial)
    return matching
      ? {
          cachedAt: matching.cachedAt,
          paramsKey: matching.paramsKey,
          deviceId: matching.state.deviceId,
          partial: Boolean(matching.state.partial),
          catalogCount: matching.state.marketplaceItems.length,
        }
      : null
  }

  async function refresh() {
    await control.command('waitFor', testId('plugins-refresh-button'), { enabled: true })
    await control.command('click', testId('plugins-refresh-button'))
    await control.command('waitFor', testId('plugins-refresh-button'), {
      enabled: true,
      stableMs: 250,
    })
  }

  async function healthyRow() {
    await control.command('waitFor', row(fixture))
    await control.command('waitFor', testId(`plugin-marketplace-actions-${fixture.pluginId}`), {
      enabled: true,
    })
  }

  async function partialNotice() {
    const selector = `${testId('plugin-operation-notice')}[data-notice-kind="error"]`
    await control.command('waitFor', selector)
    const text = await control.command('getText', selector)
    assert.match(text, /加载插件失败|插件数据未完整加载|Failed to load|incomplete/i)
    return text
  }

  function noMutations() {
    const attempted = apiProxy.requests.slice(faultRequestStart).filter(mutation)
    assert.deepEqual(attempted, [], 'Incomplete local inventory authorized a cloud mutation')
  }

  async function idleDiagnostics(label) {
    const debug = JSON.parse(
      await control.command('getWorkbenchDebugSnapshot', 'body', { value: deviceId })
    )
    assert.equal(typeof debug.pluginDeviceSyncInFlight, 'boolean')
    const { idleTasks, pluginDeviceSyncInFlight, systemPressure } = debug
    const observation = {
      label,
      at: Date.now(),
      idleTasks,
      pluginDeviceSyncInFlight,
      systemPressure,
    }
    report.lastIdleDiagnostics = observation
    // Ignore changing idle durations when deduplicating equal scheduling states.
    const fingerprint = JSON.stringify({
      ...idleTasks,
      userIdleMs: undefined,
      lastPressure: idleTasks.lastPressure
        ? { ...idleTasks.lastPressure, userIdleSeconds: undefined }
        : null,
      pluginDeviceSyncInFlight,
      systemPressure: systemPressure ? { ...systemPressure, userIdleSeconds: undefined } : null,
    })
    if (fingerprint !== lastIdleFingerprint) {
      report.idleDiagnostics.push(observation)
      if (report.idleDiagnostics.length > 60) report.idleDiagnostics.shift()
      lastIdleFingerprint = fingerprint
    }
    return observation
  }

  function physicallyIdle(observation) {
    const { idleTasks, pluginDeviceSyncInFlight, systemPressure } = observation
    return (
      idleTasks.started &&
      !idleTasks.running &&
      !idleTasks.pendingTaskIds.includes('plugins.auto-update') &&
      idleTasks.userIdleMs >= 1_500 &&
      !pluginDeviceSyncInFlight &&
      systemPressure &&
      Number.isFinite(systemPressure.cpuLoadRatio) &&
      systemPressure.cpuLoadRatio <= 0.75 &&
      Number.isFinite(systemPressure.freeMemoryRatio) &&
      systemPressure.freeMemoryRatio >= 0.1 &&
      systemPressure.userIdleSeconds >= 2
    )
  }

  async function capture(label) {
    const name = `plugin-partial-inventory-${label}.png`
    await captureScreenshot(control, name, 'body')
    return name
  }

  try {
    assert.ok(deviceId, 'Partial inventory requires a real connected desktop device')
    fixture = await installFixture(cloud, control, slug, deviceId, timeoutMs)
    report.preconditions.expected = {
      deviceId,
      updatePolicy: 'auto',
      deviceState: 'installed',
    }
    const before = await until(
      () => membership(report.preconditions),
      plugin =>
        plugin?.spec.updatePolicy === 'auto' &&
        plugin.status.devices?.some(
          device => device.deviceId === deviceId && device.state === 'installed'
        ),
      'The healthy installed auto-update control fixture did not settle',
      timeoutMs
    )
    const runtime = await materializedPlugin(executorHome, fixture.installedId)
    assert.ok(runtime, 'The baseline fixture has no real local materialization')
    Object.assign(report.preconditions, {
      completed: true,
      pluginId: fixture.pluginId,
      installedId: fixture.installedId,
      releaseId: before.spec.releaseId,
      version: before.spec.version,
      updatePolicy: before.spec.updatePolicy,
    })

    await control.command('click', testId('new-chat-button'))
    let quietSince = Date.now()
    let mutationCount = apiProxy.requests.slice(requestStart).filter(mutation).length
    await until(
      async () => {
        const requests = apiProxy.requests.slice(requestStart).filter(mutation)
        if (requests.length !== mutationCount || requests.some(request => !request.status)) {
          mutationCount = requests.length
          quietSince = Date.now()
        }
        return Date.now() - quietSince
      },
      elapsed => elapsed >= 750,
      'Healthy plugin mutations were still in flight before source fault injection',
      timeoutMs
    )
    manifestPath = await realpath(join(executorHome, 'capabilities/manifest-v2.json'))
    assert.ok(within(root, manifestPath), 'Source fault escaped the isolated run')
    const metadata = await lstat(manifestPath)
    assert.ok(metadata.isFile() && !metadata.isSymbolicLink())
    assert.equal(metadata.nlink, 1)
    mode = metadata.mode & 0o777
    original = await readFile(manifestPath)
    const manifest = JSON.parse(original)
    assert.equal(manifest.version, 2)
    assert.ok(manifest.plugins && Object.keys(manifest.plugins).length > 0)
    delete manifest.plugins
    injected = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
    report.originalManifestSha256 = hash(original)
    faultRequestStart = apiProxy.requests.length
    faultStartedAt = Date.now()
    faultActive = true
    await replaceManifest(injected)
    await checkFault('source-fault-established')
    await openPlugin(control, fixture)
    await refresh()
    await healthyRow()
    report.snapshots.push(
      await until(
        () => snapshot(true, faultStartedAt),
        Boolean,
        'The real UI did not persist a fresh partial local inventory snapshot',
        timeoutMs
      )
    )
    report.initialPartialNotice = await partialNotice()
    noMutations()

    // Policy already equals auto. Updating policy while the fault is active would
    // itself push capabilities and invalidate the controlled filesystem failure.
    await control.command('click', testId('new-chat-button'))
    report.beforePublicationIdle = await until(
      async () => {
        noMutations()
        assert.ok((await readFile(manifestPath)).equals(injected))
        return idleDiagnostics('before-release-publication')
      },
      physicallyIdle,
      'The real automatic-update scheduler was not idle before release publication',
      timeoutMs
    )
    const candidateStartedAt = Date.now()
    const appLogPath = join(resultDir, 'app.log')
    const candidateLogOffset = (await readFile(appLogPath)).length
    report.autoUpdateGuard = {
      logStartByteOffset: candidateLogOffset,
      matched: false,
      matchingLineCount: 0,
    }
    const marker = `${slug} real recovered release two`
    next = await cloud.publishPluginRelease({
      slug,
      version: '2.0.0',
      skills: { [skill]: marker },
    })
    assert.equal(next.pluginId, fixture.pluginId)
    assert.notEqual(next.releaseId, before.spec.releaseId)
    await checkFault('release-published-while-partial')
    const catalog = await pluginApi(
      cloud,
      `/plugins/marketplace?device_id=${encodeURIComponent(deviceId)}`
    )
    const candidate = catalog.items.find(item => String(item.id) === String(fixture.pluginId))
    assert.ok(candidate?.updateAvailable, 'The real control plugin has no available update')
    assert.equal(candidate.latestReleaseId, next.releaseId)
    report.candidate = {
      pluginId: candidate.id,
      latestReleaseId: candidate.latestReleaseId,
      installedVersion: candidate.installedVersion,
      updateAvailable: candidate.updateAvailable,
    }
    // Let the real release event run before any UI refresh can acquire its lease.
    await until(
      async () => {
        await idleDiagnostics('awaiting-real-partial-inventory-guard')
        noMutations()
        assert.ok((await readFile(manifestPath)).equals(injected))
        const appLog = await readFile(appLogPath)
        assert.ok(appLog.length >= candidateLogOffset, 'The renderer log was truncated')
        const matchingLineCount = appLog
          .subarray(candidateLogOffset)
          .toString('utf8')
          .split(/\r?\n/)
          .filter(
            line =>
              line.includes('[Plugins] Automatic update check failed') &&
              line.includes('Plugin auto-update requires a complete local plugin inventory')
          ).length
        report.autoUpdateGuard.matched = matchingLineCount > 0
        report.autoUpdateGuard.matchingLineCount = matchingLineCount
        return report.autoUpdateGuard.matched
      },
      Boolean,
      'The real automatic-update coordinator never reached the partial-inventory guard',
      timeoutMs
    )
    await openPlugin(control, fixture)
    await refresh()
    await healthyRow()
    report.snapshots.push(
      await until(
        () => snapshot(true, candidateStartedAt),
        Boolean,
        'The candidate refresh did not read the still-partial local inventory',
        timeoutMs
      )
    )
    report.candidatePartialNotice = await partialNotice()
    await control.command('click', row(fixture))
    const updateAction = '[data-testid^="plugin-detail-toggle-"]'
    await control.command('waitFor', updateAction, { enabled: true })
    report.candidate.updateActionText = await until(
      () => control.command('getText', updateAction),
      text => /更新|Update/.test(text),
      'The real UI did not expose the available upgrade while inventory was partial'
    )
    await control.command('click', testId('plugin-detail-back-button'))
    await healthyRow()
    let quietWindowStarted = Date.now()
    report.idleWindow = await until(
      async () => {
        noMutations()
        assert.ok((await readFile(manifestPath)).equals(injected))
        const observation = await idleDiagnostics('partial-inventory-ui-settled')
        if (
          observation.idleTasks.running ||
          observation.idleTasks.pendingTaskIds.includes('plugins.auto-update')
        ) {
          quietWindowStarted = Date.now()
        }
        return { ...observation.idleTasks, observedQuietMs: Date.now() - quietWindowStarted }
      },
      value => value.started && !value.running && value.observedQuietMs >= 2_000,
      'The partial-inventory observation window did not reach a settled renderer',
      timeoutMs
    )
    await checkFault('automatic-update-and-manual-refresh-settled')
    noMutations()
    report.blocked = {}
    const unchanged = await membership(report.blocked)
    assert.equal(unchanged.spec.releaseId, before.spec.releaseId)
    assert.equal(unchanged.spec.version, '1.0.0')
    Object.assign(report.blocked, {
      requestStart: faultRequestStart,
      requestEnd: apiProxy.requests.length,
      mutationRequests: [],
      accountReleaseId: unchanged.spec.releaseId,
      screenshot: await capture('partial-candidate-blocked'),
    })

    assert.ok((await readFile(manifestPath)).equals(injected))
    await replaceManifest(original)
    faultActive = false
    report.manifestRestored = (await readFile(manifestPath)).equals(original)
    assert.ok(report.manifestRestored)
    const restored = await executor('executor.plugins.store.list')
    assert.equal(restored.ok, true, 'The real local store did not recover')
    const recoveryStartedAt = Date.now()
    const recoveryRequestStart = apiProxy.requests.length
    await refresh()
    report.recovery = {}
    const recovered = await until(
      () => membership(report.recovery),
      plugin =>
        plugin?.spec.releaseId === next.releaseId &&
        plugin.status.devices?.some(
          device =>
            device.deviceId === deviceId &&
            device.state === 'installed' &&
            device.actualReleaseId === next.releaseId
        ),
      'Restoring complete inventory did not perform the real automatic upgrade',
      timeoutMs
    )
    await until(
      () => apiProxy.requests.slice(recoveryRequestStart),
      requests =>
        requests.some(
          request =>
            request.method === 'POST' &&
            request.path === '/api/plugins/installed/sync-device' &&
            request.status === 200
        ),
      'The recovered explicit refresh did not perform real state-repair synchronization',
      timeoutMs
    )
    report.snapshots.push(
      await until(
        () => snapshot(false, recoveryStartedAt),
        Boolean,
        'Recovery did not produce a fresh complete local catalog snapshot',
        timeoutMs
      )
    )
    const requests = apiProxy.requests.slice(recoveryRequestStart)
    assert.ok(
      requests.some(
        request =>
          request.method === 'POST' &&
          request.path === '/api/plugins/installed/auto-update-batch' &&
          request.status === 200
      ),
      'Recovery never reached the real automatic-update batch API'
    )
    assert.ok(
      requests.some(
        request =>
          request.method === 'POST' &&
          request.path === `/api/plugins/installed/${fixture.installedId}/sync-device` &&
          request.status === 200
      ),
      'Recovery never synchronized the upgraded fixture through the real API'
    )
    const active = await materializedPlugin(executorHome, fixture.installedId)
    assert.ok(active, 'Recovered upgrade is absent from the active device manifest')
    const runtimeRoot = await realpath(
      resolve(executorHome, 'capabilities', active.runtime.codex_link)
    )
    assert.ok(within(root, runtimeRoot))
    const packageManifest = JSON.parse(
      await readFile(join(runtimeRoot, '.codex-plugin/plugin.json'), 'utf8')
    )
    assert.equal(packageManifest.version, '2.0.0')
    const skillText = await readFile(join(runtimeRoot, 'skills', skill, 'SKILL.md'), 'utf8')
    assert.equal(skillText, `---\nname: ${skill}\ndescription: ${marker}\n---\n\n${marker}\n`)
    await healthyRow()
    await control.command(
      'waitFor',
      `${testId('plugin-operation-notice')}[data-notice-kind="error"]`,
      { visible: false }
    )
    report.recovered = {
      installedId: fixture.installedId,
      releaseId: recovered.spec.releaseId,
      version: packageManifest.version,
      skillSha256: hash(skillText),
      mutationRequests: requests.filter(mutation),
      screenshot: await capture('complete-inventory-upgraded'),
    }
  } catch (error) {
    failure = error
    report.error = String(error?.stack ?? error)
    try {
      report.failureScreenshot = await capture('failed')
    } catch (captureError) {
      report.captureError = String(captureError?.message ?? captureError)
    }
  } finally {
    try {
      await idleDiagnostics(failure ? 'failure-finally' : 'success-finally')
    } catch (diagnosticsError) {
      report.idleDiagnosticsError = String(diagnosticsError?.message ?? diagnosticsError)
    }
    if (faultActive && original) {
      try {
        const current = await readFile(manifestPath)
        report.faultPresentAtCleanup = current.equals(injected)
        if (!report.faultPresentAtCleanup) {
          report.cleanupConflict = {
            expectedInjectedSha256: hash(injected),
            observedSha256: hash(current),
          }
          throw new Error('Manifest cleanup conflict: current state differs from injected fault')
        }
        await replaceManifest(original)
        report.manifestRestored = (await readFile(manifestPath)).equals(original)
        assert.ok(report.manifestRestored, 'Manifest cleanup did not restore the original source')
        faultActive = false
      } catch (cleanupError) {
        report.cleanupError = String(cleanupError?.stack ?? cleanupError)
        if (!failure) {
          failure = cleanupError
          report.error = report.cleanupError
        }
      }
    }
    report.requests = apiProxy.requests
      .slice(requestStart)
      .filter(request => request.path.startsWith('/api/plugins/'))
    report.elapsedMs = Date.now() - startedAt
    report.passed = !failure && Boolean(report.recovered)
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  }
  if (failure) throw failure
  return { case: 'partial-inventory-blocks-mutations-and-recovers', reportPath }
}
