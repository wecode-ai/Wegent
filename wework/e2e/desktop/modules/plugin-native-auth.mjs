import assert from 'node:assert/strict'
import { readFile, rm, watch, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDevtoolsClient } from '../../../scripts/ai-verify-devtools.mjs'
import { TransportFaultProxy } from './transport-fault-proxy.mjs'
import { holdInstalledPluginRow, holdPluginWriteLease } from './plugin-write-lease.mjs'
import { managedRoot } from './managed-plugin-root.mjs'
import { requestPluginExecutor, until } from './plugin-regression-fixture.mjs'
import { commandOutputAsync, redisCliBinary } from './shared.mjs'

const manageSites = '[data-testid="plugin-connection-manage-group:sites"]'
const sourceAction = '[data-testid="plugin-connector-source-continue"]'
const detailError = '[data-testid="plugin-detail-action-error"]'
const logoutStepMs = 3_000

async function openNativePluginDetail(control, installedId) {
  await control.command('clickWhenEnabled', '[data-testid="plugins-button"]')
  const page = JSON.parse(await control.command('snapshot', 'body'))
  if (page.testIds.includes('plugin-detail-back-button')) {
    await control.command('click', '[data-testid="plugin-detail-back-button"]')
  }
  await control.command(
    'clickWhenEnabled',
    `[data-testid="plugins-installed-strip-item-${installedId}"]`
  )
}

async function openMailSource(control, text) {
  await control.command('clickWhenEnabled', manageSites, { timeoutMs: logoutStepMs })
  await control.command('fill', '[data-testid="plugin-connector-source-select"]', { value: 'mail' })
  return control.command('waitFor', sourceAction, { text, enabled: true, timeoutMs: logoutStepMs })
}

async function withLogoutConfirmation(control, resultDir, run) {
  await control.command('focusMainWindow', 'body')
  const mainOrigin = await control.command('getLocationOrigin', 'body')
  const client = await createDevtoolsClient(resultDir, logoutStepMs)
  const main = (await client({ action: 'targets' })).find(
    target => target.type === 'window' && target.url.startsWith(mainOrigin + '/wework/app/')
  )
  assert.ok(main, 'The main renderer must be available for Native logout confirmation')
  const page = (method, params) => client({ action: 'command', target: main.id, method, params })
  const confirm = async beforeAccept => {
    const { latest: after } = await client({ action: 'events', target: main.id })
    const accept = async () => {
      const opening = await until(
        async () =>
          (await client({ action: 'events', target: main.id, after })).events.find(
            event => event.method === 'Page.javascriptDialogOpening'
          ),
        Boolean,
        'The Native logout button did not open its confirmation',
        logoutStepMs
      )
      const expected =
        opening.params.type === 'confirm' && /^确定退出「.+」登录？/.test(opening.params.message)
      let prepared = false
      try {
        if (expected) await beforeAccept?.()
        prepared = expected
      } finally {
        await page('Page.handleJavaScriptDialog', { accept: prepared })
      }
      assert.ok(expected, 'The unexpected native dialog was canceled')
    }
    await Promise.all([
      accept(),
      control.command('clickWhenEnabled', sourceAction, { timeoutMs: logoutStepMs }),
    ])
  }
  try {
    await page('Page.enable')
    await run(confirm, page)
  } finally {
    await client({ action: 'detach', target: main.id })
  }
}

async function observeLogoutUi(page) {
  const result = await page('Runtime.evaluate', {
    expression: `(() => {
      const state = { pending: false, error: false }
      const inspect = () => {
        state.pending ||= Boolean(document.querySelector(${JSON.stringify(`${manageSites}[aria-busy="true"]:disabled`)}))
        // A failed previous operation may still have a banner until this
        // submission clears it and renders its pending state.
        state.error ||= state.pending && Boolean(document.querySelector(${JSON.stringify(detailError)}))
      }
      const observer = new MutationObserver(inspect)
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-busy', 'disabled'] })
      return () => {
        inspect()
        observer.disconnect()
        return state
      }
    })()`,
  })
  const objectId = result.result?.objectId
  assert.ok(objectId, 'The Native logout UI observer could not start')
  return async () => {
    try {
      const evidence = await page('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function () { return this() }',
        returnByValue: true,
      })
      assert.equal(evidence.exceptionDetails, undefined)
      return evidence.result.value
    } finally {
      await page('Runtime.releaseObject', { objectId })
    }
  }
}

function nativeLogoutContention(log, installedId) {
  return log
    .split('\n')
    .filter(line => line.includes('Native plugin authorization lock contention'))
    .map(line => line.split(' '))
    .filter(
      fields =>
        fields.includes('operation=plugin.auth.local_lifecycle') &&
        fields.includes(`installed_plugin_id=${installedId}`)
    )
}

function assertNativeLogoutContentionStatus(attempts) {
  const statuses = attempts.map(fields => fields.find(field => field.startsWith('http_status=')))
  assert.deepEqual(
    statuses,
    attempts.map(() => 'http_status=200'),
    'Confirmed Native logout contention must use the negotiated HTTP 200 response'
  )
}

async function waitForFirstLogoutContention(executorLog, offset, installedId, cancel) {
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(logoutStepMs)])
  try {
    // Watch the exact foreground request before dispatch; the retry window is
    // shorter than a series of runner polling and UI commands.
    for await (const _change of watch(executorLog, { signal })) {
      const log = (await readFile(executorLog, 'utf8')).slice(offset)
      const attempt = nativeLogoutContention(log, installedId).find(
        fields => fields.includes('attempt=1') && fields.includes('will_retry=true')
      )
      if (attempt) {
        assertNativeLogoutContentionStatus([attempt])
        return
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error
    throw new Error('The Native logout did not report retryable first-attempt contention', {
      cause: error,
    })
  }
}

async function verifyLogoutBudgetExhaustion({
  cloud,
  control,
  installedId,
  readGrantCount,
  connectionFor,
  executorLog,
  confirm,
}) {
  const grants = await readGrantCount()
  assert.ok(grants > 0, 'Native logout fixture must have a desktop grant to revoke')
  const held = await holdPluginWriteLease(cloud, installedId)
  try {
    const offset = (await readFile(executorLog, 'utf8')).length
    assert.equal(await openMailSource(control, '退出登录'), '退出登录')
    await confirm()
    const message = '插件授权暂时繁忙，请稍后重试。'
    const actual = await control.command('waitFor', detailError, {
      visible: true,
      text: message,
      timeoutMs: logoutStepMs,
    })
    assert.equal(actual.trim(), message)
    const attempts = nativeLogoutContention(
      (await readFile(executorLog, 'utf8')).slice(offset),
      installedId
    )
    assert.ok(
      attempts.length >= 2 && attempts.length <= 3,
      'The held lease must exhaust bounded foreground retries'
    )
    assertNativeLogoutContentionStatus(attempts)
    assert.equal((await connectionFor('mail')).status, 'connected')
    assert.equal(
      await readGrantCount(),
      grants,
      'Blocked logout must preserve existing local grants'
    )
  } finally {
    await held.release()
  }
}

async function assertLoggedOutMailSource(control) {
  await control.command('waitFor', detailError, { visible: false, timeoutMs: logoutStepMs })
  await openMailSource(control)
  await until(
    () => control.command('getText', sourceAction, { timeoutMs: logoutStepMs }),
    text => text.trim() === '登录',
    'The plugin detail did not reflect the successful Native logout',
    logoutStepMs
  )
}

async function verifyLogoutRecovery({
  cloud,
  control,
  installedId,
  readGrantCount,
  connectionFor,
  executorLog,
  confirm,
  page,
}) {
  assert.equal(await openMailSource(control, '退出登录'), '退出登录')
  const held = await holdPluginWriteLease(cloud, installedId)
  const cancel = new AbortController()
  try {
    const readUi = await observeLogoutUi(page)
    let evidence
    try {
      const offset = (await readFile(executorLog, 'utf8')).length
      await Promise.all([
        waitForFirstLogoutContention(executorLog, offset, installedId, cancel.signal).then(() =>
          held.release()
        ),
        confirm(),
      ])
      await control.command('waitFor', `${manageSites}[aria-busy="false"]`, {
        enabled: true,
        timeoutMs: logoutStepMs,
      })
      assertNativeLogoutContentionStatus(
        nativeLogoutContention((await readFile(executorLog, 'utf8')).slice(offset), installedId)
      )
    } finally {
      evidence = await readUi()
    }
    assert.deepEqual(
      evidence,
      { pending: true, error: false },
      'Recoverable contention must stay pending without exposing a UI error'
    )
    await assertLoggedOutMailSource(control)
    assert.equal((await connectionFor('mail')).status, 'disconnected')
    assert.equal(await readGrantCount(), 0, 'Native logout must revoke its committed grants')
  } finally {
    cancel.abort()
    await held.release()
  }
  await control.command('click', '[data-testid="plugin-connector-source-cancel"]')
}

async function readNativeGrantCount(cloud, connectionId) {
  const [row] = await cloud.queryDatabase(
    `SELECT JSON_LENGTH(JSON_EXTRACT(json, '$.spec.localGrants')) AS grants
     FROM kinds WHERE user_id=1 AND kind='ConnectorConnection' AND namespace='plugin-auth' AND name=%s`,
    [connectionId]
  )
  return row.grants
}

async function verifyContendedNativeLogout({
  cloud,
  control,
  installedId,
  connectionFor,
  resultDir,
}) {
  await openNativePluginDetail(control, installedId)
  const connection = await connectionFor('mail')
  assert.equal(connection?.status, 'connected')
  const readGrantCount = () => readNativeGrantCount(cloud, connection.id)
  await withLogoutConfirmation(control, resultDir, async (confirm, page) => {
    const context = {
      cloud,
      control,
      installedId,
      connectionFor,
      readGrantCount,
      confirm,
      page,
      executorLog: join(resultDir, 'executor.log'),
    }
    await verifyLogoutBudgetExhaustion(context)
    await verifyLogoutRecovery(context)
  })
}

async function verifyNativeLogoutAfterLeaseTimeout({
  cloud,
  control,
  installedId,
  connectionFor,
  resultDir,
}) {
  const redisHost = '127.0.0.1'
  assert.ok(cloud.redis?.pid && Number.isSafeInteger(cloud.redisPort))
  assert.equal(cloud.backendEnv.REDIS_URL, `redis://${redisHost}:${cloud.redisPort}/0`)
  const redis = (...args) =>
    commandOutputAsync(redisCliBinary(), ['-h', redisHost, '-p', String(cloud.redisPort), ...args])
  const executorLog = join(resultDir, 'executor.log')
  await openNativePluginDetail(control, installedId)
  assert.equal(await openMailSource(control, '退出登录'), '退出登录')
  const before = await connectionFor('mail')
  assert.equal(before?.status, 'connected')
  assert.ok((await readNativeGrantCount(cloud, before.id)) > 0)

  await withLogoutConfirmation(control, resultDir, async (confirm, page) => {
    const offset = (await readFile(executorLog, 'utf8')).length
    const readUi = await observeLogoutUi(page)
    let evidence
    try {
      // Arm the isolated Redis while the confirmation still blocks dispatch.
      await confirm(async () => {
        assert.equal(await redis('CLIENT', 'PAUSE', '2450', 'WRITE'), 'OK')
      })
      await control.command('waitFor', `${manageSites}[aria-busy="false"]`, {
        enabled: true,
        timeoutMs: 5_000,
      })
    } finally {
      const [, state] = await Promise.all([redis('CLIENT', 'UNPAUSE'), readUi()])
      evidence = state
    }
    assert.deepEqual(
      evidence,
      { pending: true, error: false },
      'Recovering from a Redis lease timeout must stay pending without exposing a UI error'
    )
    const attempts = nativeLogoutContention(
      (await readFile(executorLog, 'utf8')).slice(offset),
      installedId
    )
    assert.deepEqual(
      attempts.map(fields =>
        fields.filter(field => /^(?:attempt|error|will_retry)=/.test(field)).sort()
      ),
      [1, 2].map(attempt => [
        `attempt=${attempt}`,
        'error=plugin_write_lease_timeout',
        'will_retry=true',
      ]),
      'The first two Native logout requests must receive retryable lease timeouts'
    )
    assertNativeLogoutContentionStatus(attempts)
  })
  await assertLoggedOutMailSource(control)
  const after = await connectionFor('mail')
  assert.equal(after?.status, 'disconnected')
  assert.equal(after.id, before.id)
  assert.equal(after.revision, before.revision + 1, 'Only one logout can commit')
  assert.equal(await readNativeGrantCount(cloud, before.id), 0)
  await control.command('click', '[data-testid="plugin-connector-source-cancel"]')
}

/** Extend the CI-covered password checkpoint using its real authorized host. */
export async function verifyPluginNativeAuth({
  cloud,
  control,
  executorHome,
  homePath,
  sourceAuth,
  installedId,
  signalAutomaticRetry,
  connectionFor,
  invokeLocal,
  resultDir,
  timeoutMs,
}) {
  const flags = { ...cloud.backendEnv }
  const current = (await requestPluginExecutor(control, 'executor.backend.status')).payload.result
  const stored = JSON.parse(
    await control.command('getLocalStorageItem', 'body', {
      value: 'wework.cloudConnection',
    })
  )
  const restoreProfile = async profile => {
    await control.command('setAppPreferences', 'body', {
      value: JSON.stringify({ cloudConnection: profile }),
    })
    const readyCount = control.readyCount
    await control.command('reloadMainWindow', 'body')
    await control.awaitReadyAfter(readyCount)
  }
  const proxy = await new TransportFaultProxy(cloud.backendUrl).start()
  const fault = proxy.rejectDeviceRegistration()
  const runtime = await fetch(`${cloud.backendUrl}/api/users/me/wegent-runtime-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cloud.authToken}` },
  })
  assert.ok(runtime.ok)
  const runtimeToken = (await runtime.json()).auth_token
  const configure = socket =>
    requestPluginExecutor(control, 'executor.backend.configure', {
      backend_url: cloud.backendUrl,
      socket_url: socket,
      auth_token: cloud.authToken,
      runtime_auth_token: runtimeToken,
      device_type: 'app',
    })
  const localAuth = action =>
    control.command('localConnectorAuth', 'body', {
      value: JSON.stringify({ pluginKey: 'desktop-account-auth', connectorSlug: 'mail', action }),
    })
  const grantMailLocally = async () => {
    await localAuth('start')
    await signalAutomaticRetry()
    await until(
      async () => {
        const mail = await connectionFor('mail')
        return mail && (await readNativeGrantCount(cloud, mail.id))
      },
      value => value > 0,
      'Native login did not grant its desktop key',
      timeoutMs
    )
    await rm(sourceAuth)
  }
  try {
    await cloud.stopBackend()
    cloud.backendEnv = { ...flags, PLUGIN_LOCAL_SYNC_ENABLED: 'true' }
    await cloud.launchBackend()
    // Change the authoritative profile too: a real token renewal must keep
    // exercising the rejected registration instead of restoring a direct URL.
    await restoreProfile({ ...stored, socketBaseUrl: proxy.url, socketBaseUrlOverride: proxy.url })
    await configure(proxy.url)
    await until(
      () => fault.rejected,
      value => value > 0,
      'A real Backend rejection of device registration was not observed',
      timeoutMs
    )
    assert.equal(fault.error, null)
    const status = (await requestPluginExecutor(control, 'executor.backend.status')).payload.result
    assert.equal(status.connected, false, 'Plugin authorization must not mark Device registered')
    const authorization = JSON.parse(
      await control.command('configurePluginNativeAuthorization', 'body')
    )
    assert.equal(authorization.ready, true)
    assert.ok(authorization.expiresIn > 0)
    // A new key does not silently inherit credentials from a registered Device.
    // Explicit login uses the existing local login entry and Native principal.
    await grantMailLocally()
    const root = await managedRoot(executorHome, installedId)
    assert.ok(root)
    await invokeLocal(root)
    assert.equal(
      (await requestPluginExecutor(control, 'executor.backend.status')).payload.result.connected,
      false
    )

    // Installation uses the existing unified installer independently of both
    // the rejected registration and the managed authentication exchange.
    const slug = 'native-registration-rejected'
    const release = await cloud.publishPluginRelease({
      slug,
      version: '1.0.0',
      skills: { [slug]: slug },
    })
    const sync = async params => {
      const response = await requestPluginExecutor(control, 'executor.plugins.local_sync', {
        backend_url: cloud.backendUrl,
        auth_token: cloud.authToken,
        ...params,
      })
      assert.equal(response.payload.error, undefined)
      assert.equal(response.payload.result.localCompleted, true)
      return response.payload.result
    }
    const backgroundRow = await holdInstalledPluginRow(cloud, installedId)
    try {
      await signalAutomaticRetry()
      await backgroundRow.waitFor('blocked')
      const installed = await sync({ action: 'install', targetId: release.pluginId })
      const id = Number(installed.operation.plugin.metadata.labels.id)
      assert.ok(await managedRoot(executorHome, id))
      const upgrade = await cloud.publishPluginRelease({
        slug,
        version: '1.0.1',
        skills: { [slug]: `${slug} updated` },
      })
      const updated = await sync({
        action: 'update',
        targetId: id,
        payload: { releaseId: upgrade.releaseId },
      })
      assert.equal(updated.operation.plugin.spec.version, '1.0.1')
      const updatedRoot = await managedRoot(executorHome, id)
      assert.ok(updatedRoot)
      assert.equal(
        JSON.parse(await readFile(join(updatedRoot, '.codex-plugin/plugin.json'), 'utf8')).version,
        '1.0.1'
      )
      await sync({ action: 'uninstall', targetId: id })
      assert.equal(await managedRoot(executorHome, id), null)
    } finally {
      await backgroundRow.release()
    }
    await verifyContendedNativeLogout({
      cloud,
      control,
      installedId,
      connectionFor,
      resultDir,
    })
    await grantMailLocally()
    await verifyNativeLogoutAfterLeaseTimeout({
      cloud,
      control,
      installedId,
      connectionFor,
      resultDir,
    })
    assert.equal(
      (await requestPluginExecutor(control, 'executor.backend.status')).payload.result.connected,
      false
    )
    await writeFile(
      join(resultDir, 'plugin-native-registration-rejection.json'),
      JSON.stringify(
        {
          backendRejectedRegistration: fault.rejected,
          nativeAuthorization: true,
          localConversation: true,
          installed: true,
          updated: true,
          uninstalled: true,
          logout: true,
          logoutRecoveredFromRedisContention: true,
          logoutRecoveredFromRedisLeaseTimeout: true,
          logoutBusyFeedbackPreservedGrants: true,
          deviceStatusRemainsDisconnected: true,
          backgroundAuthDoesNotBlockDifferentPlugin: true,
        },
        null,
        2
      )
    )
  } finally {
    try {
      await writeFile(
        join(resultDir, 'plugin-native-registration-fault.json'),
        JSON.stringify(
          {
            submitted: fault.submitted,
            rejected: fault.rejected,
            transportError: fault.error ? String(fault.error.message) : null,
          },
          null,
          2
        )
      )
      await cloud.stopBackend()
      cloud.backendEnv = flags
      await cloud.launchBackend()
      await restoreProfile(stored)
      await configure(current.socket_url || cloud.backendUrl)
    } finally {
      await proxy.stop()
    }
  }
}
