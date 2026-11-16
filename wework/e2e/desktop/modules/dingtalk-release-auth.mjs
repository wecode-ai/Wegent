import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { managedRoot } from './managed-plugin-root.mjs'
import { CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID } from './shared.mjs'
import { createDingtalkOAuthProtocol } from './dingtalk-oauth-protocol.mjs'
import { openPlugin } from './plugin-regression-fixture.mjs'
import { verifySnapshotFixtureContract } from './local-snapshot-auth-fixture-contract.mjs'

const run = promisify(execFile)
const fixture = fileURLToPath(new URL('../fixtures/dingtalk-releases.py', import.meta.url))
const quote = value => `'${value.replaceAll("'", "'\\''")}'`

/** Existing password/DWS checkpoints own independent, initially empty auth stores. */
export function createDingtalkReleaseChecks({ checkpoint, resultDir, sourceRoot }) {
  if (!['plugin-account-auth-password', 'plugin-account-auth-dws'].includes(checkpoint)) return null
  const upgrade = checkpoint === 'plugin-account-auth-dws'
  const protocol = createDingtalkOAuthProtocol({ resultDir, sourceRoot })
  let directory
  return {
    async prepareApp(context) {
      if (!upgrade) await verifySnapshotFixtureContract(resultDir)
      directory = await prepareDingtalkReleases(resultDir, upgrade)
      await protocol.prepareApp(context)
    },
    handleHttp: (...args) => protocol.handleHttp(...args),
    async verify(options) {
      await verifyDingtalkReleaseAuth({ upgrade, directory, protocol, ...options })
      if (upgrade) {
        // The next existing case owns a different account and transfer receipt.
        // Clear only this checkpoint's synthetic store after uninstall settles.
        assert.equal(sourceRoot, join(resultDir, 'dws-source'))
        for (const name of ['config', 'keychain']) {
          const path = join(sourceRoot, name)
          await rm(path, { recursive: true, force: true })
          await mkdir(path, { recursive: true })
        }
      }
      await openPlugin(options.control, { slug: options.returnPluginKey })
    },
  }
}

async function prepareDingtalkReleases(resultDir, upgrade) {
  const directory = join(resultDir, 'dingtalk-releases')
  const result = await run(
    'uv',
    [
      'run',
      '--no-project',
      'python',
      fixture,
      '--directory',
      directory,
      '--versions',
      ...(upgrade ? ['0.3.5', '0.3.6'] : ['0.3.6']),
    ],
    { timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }
  ).catch(async error => {
    await writeFile(
      join(resultDir, 'dingtalk-release-build.log'),
      `${error.stdout ?? ''}${error.stderr ?? ''}`
    )
    throw error
  })
  await writeFile(join(resultDir, 'dingtalk-release-build.log'), `${result.stdout}${result.stderr}`)
  return directory
}

async function verifyDingtalkReleaseAuth({
  upgrade,
  directory,
  protocol,
  cloud,
  control,
  executorHome,
  api,
  waitForValue,
  timeoutMs,
  signalAutomaticRetry,
  invoke,
}) {
  const evidence = []
  const local = await cloud.waitForConnectedAppDevice()
  const device = local.execution_target_id
  const connections = async () =>
    (await api('/plugin-connections')).filter(
      item => item.plugin_key === 'dingtalk' || item.connector_slug.startsWith('dingtalk-')
    )
  assert.deepEqual(await connections(), [], 'The release case inherited account metadata')
  await protocol.assertNoLocalLogin()
  const publish = async version => {
    const path = join(directory, `dingtalk-${version}.zip`)
    return cloud.publishPluginRelease({
      slug: 'dingtalk',
      version,
      prebuilt: {
        path,
        sha256: createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      },
    })
  }
  const health = connectorSlug =>
    control
      .command('localConnectorAuth', 'body', {
        value: JSON.stringify({ pluginKey: 'dingtalk', connectorSlug, action: 'health' }),
      })
      .then(JSON.parse)
  const initialVersion = upgrade ? '0.3.5' : '0.3.6'
  const initial = await publish(initialVersion)
  await protocol.arm()
  await openPlugin(control, { slug: 'dingtalk' })
  await control.command(
    'waitFor',
    `[data-testid="plugin-marketplace-install-${initial.pluginId}"]`,
    { timeoutMs }
  )
  await control.command('click', `[data-testid="plugin-marketplace-install-${initial.pluginId}"]`)
  await control.command('clickWhenEnabled', '[data-testid="install-plugin-dialog-confirm"]')
  await control.command('waitFor', '[data-testid="local-connector-auth-dialog"]', { timeoutMs })
  await waitForValue(
    () => protocol.authorization,
    Boolean,
    timeoutMs,
    'Install did not initiate real DWS OAuth'
  )
  assert.equal((await health(upgrade ? 'dingtalk-local' : 'dingtalk-access')).status, 'need_login')
  assert.deepEqual(await connections(), [], 'A connection existed before OAuth success')
  await protocol.approve()
  await control.command('waitFor', '[data-testid="plugin-operation-notice"]', {
    text: '已安装',
    timeoutMs,
  })
  await waitForValue(
    () => control.command('snapshot', 'body').then(JSON.parse),
    snapshot => !snapshot.testIds.includes('local-connector-auth-dialog'),
    timeoutMs,
    'Successful installation did not complete the unified auth entry'
  )
  const installed = (await api('/plugins/installed')).items.find(
    item => item.spec.source.pluginKey === 'dingtalk'
  )
  const id = Number(installed?.metadata?.labels?.id)
  assert.ok(Number.isSafeInteger(id) && id > 0)
  await api(`/plugins/installed/${id}?device_id=${device}`, 'PUT', { updatePolicy: 'manual' })
  await api(`/plugins/marketplace/${initial.pluginId}/install?device_id=${CLOUD_DEVICE_ID}`, 'POST')
  await signalAutomaticRetry()
  const before = await waitForValue(
    connections,
    list =>
      list.length === 1 &&
      list[0].status === 'connected' &&
      [device, CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID].every(target =>
        list[0].device_ids.includes(target)
      ),
    timeoutMs,
    'Real OAuth login did not create and synchronize its account connection'
  ).then(list => list[0])
  assert.equal(before.connector_slug, 'dingtalk-access')
  assert.equal(before.account_id, 'synthetic-e2e-corp:synthetic-e2e-user')
  const rootsAt = version =>
    Promise.all(
      [executorHome, dirname(cloud.remoteCodexHome)].map(home =>
        waitForValue(
          async () => {
            const root = await managedRoot(home, id)
            if (!root) return null
            const manifest = JSON.parse(
              await readFile(join(root, '.codex-plugin/plugin.json'), 'utf8')
            )
            return manifest.version === version ? root : null
          },
          Boolean,
          timeoutMs,
          `Delivered DingTalk ${version} was not materialized on both devices`
        )
      )
    )
  const checkBusiness = root =>
    invoke(
      `sh ${quote(join(root, 'scripts/run-dws.sh'))} account-status`,
      JSON.stringify({ accountId: before.account_id, authenticated: true })
    )
  const oldRoots = await rootsAt(initialVersion)
  await checkBusiness(oldRoots[1])
  evidence.push({
    phase: 'installed',
    version: initialVersion,
    connectionId: before.id,
    accountId: before.account_id,
    status: before.status,
    deviceIds: before.device_ids,
  })
  const requestsBeforeUpgrade = protocol.requests.length
  if (upgrade) {
    const updated = await publish('0.3.6')
    await api(`/plugins/installed/${id}?device_id=${device}`, 'PUT', {
      releaseId: updated.releaseId,
    })
    const newRoots = await rootsAt('0.3.6')
    assert.equal(
      (await health('dingtalk-access')).status,
      'ok',
      'Upgrade invalidated the existing local login'
    )
    const current = await connections()
    assert.equal(current.length, 1, 'Upgrade duplicated the account connection')
    assert.equal(current[0].id, before.id)
    assert.equal(current[0].account_id, before.account_id)
    assert.equal(current[0].status, 'connected')
    assert.ok(
      before.device_ids.every(target => current[0].device_ids.includes(target)),
      'Upgrade removed existing device grants'
    )
    assert.equal(
      protocol.requests.length,
      requestsBeforeUpgrade,
      'Upgrade unexpectedly initiated OAuth again'
    )
    await checkBusiness(newRoots[1])
    evidence.push({
      phase: 'upgraded',
      version: '0.3.6',
      connectionId: current[0].id,
      accountId: current[0].account_id,
      status: current[0].status,
      deviceIds: current[0].device_ids,
    })
    // The existing exclusive-transfer regression installs its independent package next.
    const response = await fetch(
      `${cloud.backendUrl}/api/plugins/installed/${id}?device_id=${device}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${cloud.authToken}` },
      }
    )
    assert.equal(response.status, 204)
    await waitForValue(
      () => api('/plugins/installed'),
      list => !list.items.some(item => Number(item.metadata.labels.id) === id),
      timeoutMs,
      'Release fixture uninstall did not complete'
    )
    await waitForValue(
      () =>
        Promise.all(
          [executorHome, dirname(cloud.remoteCodexHome)].map(home => managedRoot(home, id))
        ),
      roots => roots.every(root => root === null),
      timeoutMs,
      'Release fixture uninstall did not settle on both executors'
    )
  } else {
    assert.equal((await health('dingtalk-access')).status, 'ok')
  }
  await writeFile(
    join(dirname(directory), 'dingtalk-release-runtime.json'),
    JSON.stringify(
      {
        sources: JSON.parse(await readFile(join(directory, 'sources.json'), 'utf8')),
        evidence,
        oauthRequests: protocol.requests,
        boundary:
          'Synthetic external OAuth; real CLI, installed packages, native auth, Backend and executors',
      },
      null,
      2
    )
  )
}
