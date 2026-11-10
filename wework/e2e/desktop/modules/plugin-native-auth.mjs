import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TransportFaultProxy } from './transport-fault-proxy.mjs'
import { managedRoot } from './managed-plugin-root.mjs'
import { requestPluginExecutor, until } from './plugin-regression-fixture.mjs'

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
  try {
    await cloud.stopBackend()
    cloud.backendEnv = { ...flags, PLUGIN_LOCAL_SYNC_ENABLED: 'true' }
    await cloud.launchBackend()
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
    await localAuth('start')
    await signalAutomaticRetry()
    await until(
      async () => {
        const rows = await cloud.queryDatabase(
          "SELECT json FROM kinds WHERE user_id=1 AND kind='ConnectorConnection' AND namespace='plugin-auth' AND name=%s",
          [(await connectionFor('mail')).id]
        )
        const document =
          typeof rows[0]?.json === 'string' ? JSON.parse(rows[0].json) : rows[0]?.json
        return Object.keys(document?.spec?.localGrants ?? {}).length
      },
      value => value > 0,
      'Native login did not grant its desktop key',
      timeoutMs
    )
    await rm(sourceAuth)
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
    const installed = await sync({ action: 'install', targetId: release.pluginId })
    const id = Number(installed.operation.plugin.metadata.labels.id)
    assert.ok(await managedRoot(executorHome, id))
    await cloud.publishPluginRelease({
      slug,
      version: '1.0.1',
      skills: { [slug]: `${slug} updated` },
    })
    const updated = await sync({ action: 'update', targetId: id })
    assert.equal(updated.operation.plugin.spec.version, '1.0.1')
    await sync({ action: 'uninstall', targetId: id })
    assert.equal(await managedRoot(executorHome, id), null)
    assert.equal(JSON.parse(await localAuth('logout')).status, 'ok')
    assert.equal((await connectionFor('mail')).status, 'disconnected')
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
          deviceStatusRemainsDisconnected: true,
        },
        null,
        2
      )
    )
  } finally {
    await proxy.stop()
    await cloud.stopBackend()
    cloud.backendEnv = flags
    await cloud.launchBackend()
    await configure(current.socket_url || cloud.backendUrl)
  }
}
