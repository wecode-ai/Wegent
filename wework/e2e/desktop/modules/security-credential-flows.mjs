import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { signInDesktopCloud, disconnectDesktopCloud } from './desktop-cloud-login.mjs'
import { until } from './plugin-regression-fixture.mjs'
import { withNativePluginDecision } from './native-plugin-approval.mjs'
import { invokeLocalHost } from './runtime-request.mjs'

export async function verifyRealCloudCredentials({
  control,
  cloud,
  proxy,
  electronUserDataDirectory,
  restartDesktopApp,
  resultDir,
}) {
  const user = await signInDesktopCloud(control, cloud, { backendUrl: proxy.url })
  const cloudCredentialsPath = join(
    electronUserDataDirectory,
    'protected-credentials',
    'cloud-credentials.json'
  )
  const cloudCredentials = JSON.parse(await readFile(cloudCredentialsPath, 'utf8'))
  assert.equal(cloudCredentials.version, 3, 'Real cloud credentials must use OS-protected storage')
  assert.ok(!('privateKey' in cloudCredentials) && !('refreshToken' in cloudCredentials))
  const refreshes = () =>
    proxy.requests.filter(
      request =>
        request.method === 'POST' &&
        request.path === '/api/auth/wework/refresh' &&
        request.status === 200 &&
        request.responseCompleted
    )
  const beforeRestart = refreshes().length
  await restartDesktopApp()
  await until(
    refreshes,
    requests => requests.length > beforeRestart,
    'Restart did not refresh credentials against the real Backend'
  )
  await until(
    () =>
      Promise.resolve(
        proxy.requests.filter(
          request =>
            request.method === 'GET' &&
            request.path === '/api/users/me' &&
            request.status === 200 &&
            request.responseCompleted
        )
      ),
    requests => requests.some(request => request.receivedAt >= refreshes().at(-1).receivedAt),
    'The refreshed token did not authenticate a real user request'
  )
  await control.command('waitFor', '[data-testid="desktop-sidebar-account"]', {
    text: user.user_name,
    visible: true,
  })
  await writeFile(
    join(resultDir, 'real-cloud-credentials-result.json'),
    JSON.stringify(
      {
        credentialVersion: 3,
        userId: user.id,
        restarted: true,
        requests: proxy.requests.filter(
          request => request.path === '/api/auth/wework/refresh' || request.path === '/api/users/me'
        ),
      },
      null,
      2
    )
  )
  await disconnectDesktopCloud(control)
  const cleared = JSON.parse(await readFile(cloudCredentialsPath, 'utf8'))
  assert.equal(cleared.version, 3)
  assert.equal(cleared.ciphertext, null, 'Logout must leave an empty marker')
}

export async function verifyNativePluginAdmission({
  control,
  electronUserDataDirectory,
  resultDir,
}) {
  // Exercise the public HTTP caller as well as the management UI; it cannot bypass native consent.
  const pluginRoot = join(resultDir, 'native-approval-plugin')
  await mkdir(pluginRoot, { recursive: true })
  await writeFile(
    join(pluginRoot, 'package.json'),
    JSON.stringify({
      name: 'dsh-security-approval',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
  )
  await writeFile(join(pluginRoot, 'cordis.patch.yml'), '[]\n')
  const profilePath = join(
    electronUserDataDirectory,
    'dsh-core',
    'profiles',
    'wework-core',
    'package.json'
  )
  const profileBefore = await readFile(profilePath, 'utf8')
  // Use the existing package-transaction budget: pnpm and validation are serial,
  // and the measured install alone takes over nine seconds in addition to native consent.
  const packageTransaction = { timeoutMs: 60_000 }
  const install = () =>
    invokeLocalHost(
      control,
      'runtime.installCoreDshPlugin',
      { spec: `file:${pluginRoot}` },
      packageTransaction
    )
  await assert.rejects(withNativePluginDecision(control, install, { allow: false }), /cancelled/)
  assert.equal(await readFile(profilePath, 'utf8'), profileBefore)
  const plugins = await withNativePluginDecision(control, install)
  assert.ok(plugins.some(plugin => plugin.name === 'dsh-security-approval' && plugin.enabled))
  const installedProfile = await readFile(profilePath, 'utf8')
  const update = () =>
    invokeLocalHost(
      control,
      'runtime.updateCoreDshPlugin',
      { name: 'dsh-security-approval' },
      packageTransaction
    )
  await assert.rejects(withNativePluginDecision(control, update, { allow: false }), /cancelled/)
  assert.equal(await readFile(profilePath, 'utf8'), installedProfile)
  const updated = await withNativePluginDecision(control, update)
  assert.ok(updated.some(plugin => plugin.name === 'dsh-security-approval' && plugin.enabled))
  await invokeLocalHost(
    control,
    'runtime.uninstallCoreDshPlugin',
    { name: 'dsh-security-approval' },
    packageTransaction
  )

  const develop = () =>
    invokeLocalHost(
      control,
      'pluginDevelopment.start',
      { sourceRoot: pluginRoot },
      packageTransaction
    )
  await assert.rejects(withNativePluginDecision(control, develop, { allow: false }), /cancelled/)
  assert.deepEqual(await invokeLocalHost(control, 'pluginDevelopment.list'), [])
  try {
    const session = await withNativePluginDecision(control, develop)
    assert.ok(session.electronPid > 0)
    await until(
      () => invokeLocalHost(control, 'pluginDevelopment.list'),
      sessions =>
        sessions.some(
          item => item.id === session.id && item.status === 'ready' && item.coreDshPid > 0
        ),
      'Native-approved development source did not start its real Core runtime',
      60_000
    )
  } finally {
    await invokeLocalHost(control, 'pluginDevelopment.stop', undefined, packageTransaction)
  }
  const [stopped] = await invokeLocalHost(control, 'pluginDevelopment.list')
  assert.equal(stopped.status, 'stopped')
  assert.equal(stopped.electronPid, null)
}
