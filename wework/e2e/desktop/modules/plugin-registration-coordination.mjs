import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { CLOUD_DEVICE_ID } from './shared.mjs'
import { holdPluginWriteLease } from './plugin-write-lease.mjs'
import { installFixture, materializedPlugin, until } from './plugin-regression-fixture.mjs'

const run = promisify(execFile)
const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

export async function verifyPluginRegistrationCoordination({
  cloud,
  control,
  localDeviceId,
  evidence,
  timeoutMs,
}) {
  const remoteHome = dirname(cloud.remoteCodexHome)
  const manifest = async () =>
    JSON.parse(await readFile(resolve(remoteHome, 'capabilities/manifest-v2.json'), 'utf8'))
  const seed = async generation => {
    const { stdout } = await run(
      'uv',
      [
        'run',
        '--no-sync',
        'python',
        resolve(repoDir, 'wework/e2e/desktop/support/registration-capabilities.py'),
      ],
      {
        cwd: resolve(repoDir, 'backend'),
        env: {
          ...process.env,
          WEWORK_E2E_DATABASE_URL: cloud.databaseUrl,
          WEWORK_E2E_CAPABILITY_GENERATION: generation,
        },
      }
    )
    return JSON.parse(stdout)
  }
  const hasCapabilities = (value, item) =>
    Boolean(value.skills?.[item.name]?.managed && value.mcps?.[item.name]?.managed)
  const item = await installFixture(
    cloud,
    control,
    'registration-coordination-plugin',
    localDeviceId,
    timeoutMs
  )
  const old = await seed('old')
  await cloud.restartCloudExecutor()
  await until(
    async () => ({
      manifest: await manifest(),
      plugin: await materializedPlugin(remoteHome, item.installedId),
    }),
    value => hasCapabilities(value.manifest, old) && Boolean(value.plugin),
    'Initial real registration did not install Skills, MCP and plugin',
    timeoutMs
  )
  const fresh = await seed('new')
  await cloud.executeDatabase(
    'UPDATE kinds SET is_active = 0 WHERE user_id = %s AND namespace = %s AND id IN (%s, %s)',
    [1, 'default', old.installedSkillId, old.mcpId]
  )
  const rows = () =>
    cloud.queryDatabase(
      'SELECT state, actual_release_id, desired_release_id, last_sync_at FROM plugin_device_installations WHERE user_id = %s AND installed_kind_id = %s AND device_id = %s',
      [1, item.installedId, CLOUD_DEVICE_ID]
    )
  const lease = await holdPluginWriteLease(cloud)
  try {
    // Seed an unconfirmed install under the real lease so heartbeat ACKs cannot
    // race the fixture setup. Only a later full registration may confirm it.
    const changed = await cloud.executeDatabase(
      'UPDATE plugin_device_installations SET state = %s, actual_release_id = 0 WHERE user_id = %s AND installed_kind_id = %s AND device_id = %s',
      ['pending', 1, item.installedId, CLOUD_DEVICE_ID]
    )
    assert.equal(changed.affected, 1)
    const before = await rows()
    assert.equal(before.length, 1)
    const logOffset = (await readFile(cloud.backendLogPath, 'utf8')).length
    const revision = (await manifest()).revision
    await cloud.restartCloudExecutor()
    await lease.waitFor('contended')
    await until(
      manifest,
      value => value.revision > revision && hasCapabilities(value, fresh),
      'Contended registration did not merge fresh Skills/MCP',
      timeoutMs
    )
    const merged = await manifest()
    const registrationLog = (await readFile(cloud.backendLogPath, 'utf8')).slice(logOffset)
    assert.match(registrationLog, /Plugin sync after register deferred/)
    assert.match(registrationLog, /mode=merge .*plugin_names=\[\]/)
    assert.ok(hasCapabilities(merged, old), 'Merge prematurely removed obsolete Skills/MCP')
    assert.ok(
      await materializedPlugin(remoteHome, item.installedId),
      'Merge removed the existing local plugin'
    )
    assert.deepEqual(
      await rows(),
      before,
      'Merge-only sync wrote a plugin installation acknowledgement'
    )
    evidence.push({
      case: 'contended-registration-merges-skills-mcp-and-preserves-plugin-without-ack',
      revision: merged.revision,
    })
  } finally {
    await lease.release()
  }
  await cloud.restartCloudExecutor()
  await until(
    async () => ({ manifest: await manifest(), rows: await rows() }),
    value =>
      hasCapabilities(value.manifest, fresh) &&
      !value.manifest.skills?.[old.name] &&
      !value.manifest.mcps?.[old.name] &&
      value.rows[0]?.state === 'installed' &&
      value.rows[0]?.actual_release_id === item.releaseId,
    'Uncontended reconnect did not replace obsolete capabilities and confirm the plugin',
    timeoutMs
  )
  assert.ok(await materializedPlugin(remoteHome, item.installedId))
  evidence.push({
    case: 'registration-recovery-replaces-obsolete-capabilities-and-converges-plugin-state',
  })
}
