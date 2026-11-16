import assert from 'node:assert/strict'
import { cp, lstat, readFile, realpath, rm } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { holdPluginWriteLease } from './plugin-write-lease.mjs'
import {
  accountPlugin,
  installFixture,
  materializedPlugin,
  pluginApi,
  uninstallInUi,
  until,
} from './plugin-regression-fixture.mjs'

function within(root, path) {
  const child = relative(root, path)
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

/** Seed historical account-record cleanup without inventing a local installation ID. */
export async function purgeUninstalledFixtureRecord(cloud, item) {
  const lease = await holdPluginWriteLease(cloud)
  try {
    const removed = await cloud.executeDatabase(
      "DELETE FROM kinds WHERE id = %s AND user_id = %s AND namespace = %s AND kind = %s AND is_active = 0 AND JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.source.pluginKey')) = %s",
      [item.installedId, 1, 'default', 'InstalledPlugin', item.slug]
    )
    assert.equal(removed.affected, 1, 'Cleanup must remove exactly the inactive fixture record')
  } finally {
    await lease.release()
  }
}

/** Exercise the installer's historical directory-copy layout using real package bytes. */
export async function verifyPluginCopiedSourceReinstall({
  cloud,
  control,
  executorHome,
  codexSqliteHome,
  localDeviceId,
  timeoutMs,
}) {
  const slug = 'copied-source-e2e-reinstall'
  const oldVersion = '0.1.6'
  const newVersion = '0.9.12'
  let installedId
  try {
    const first = await cloud.publishPluginRelease({
      slug,
      version: oldVersion,
      skills: { [slug]: `Copied source ${oldVersion}` },
    })
    const item = await installFixture(cloud, control, slug, localDeviceId, timeoutMs, first)
    installedId = item.installedId
    const old = await until(
      () => materializedPlugin(executorHome, installedId),
      plugin => plugin?.version === oldVersion,
      'The old package did not materialize',
      timeoutMs
    )
    const runtime = await realpath(old.runtime.codex_link)
    assert.equal(basename(runtime), oldVersion)
    assert.equal(old.name, slug)
    assert.ok(['wegent', 'wework'].includes(old.marketplace))
    const roots = await Promise.all(
      [executorHome, codexSqliteHome].filter(Boolean).map(path => realpath(path))
    )
    assert.ok(
      roots.some(root => within(root, runtime)),
      'Runtime is outside the isolated fixture'
    )
    const home = resolve(runtime, '../../../../..')
    const source = join(home, 'plugins', 'marketplaces', old.marketplace, 'plugins', slug)
    const marker = '.codex-plugin/plugin.json'
    assert.equal(JSON.parse(await readFile(join(source, marker), 'utf8')).version, oldVersion)
    if ((await lstat(source)).isSymbolicLink()) {
      assert.equal(await realpath(source), runtime)
      await rm(source, { recursive: true })
      await cp(runtime, source, { recursive: true, errorOnExist: true, force: false })
    }
    assert.equal((await lstat(source)).isSymbolicLink(), false, 'Fixture must be an ordinary copy')

    await uninstallInUi(control, item)
    await until(
      () => accountPlugin(cloud, slug),
      plugin => !plugin,
      'Account uninstall did not commit',
      timeoutMs
    )
    await until(
      () => materializedPlugin(executorHome, installedId),
      plugin => !plugin,
      'Device uninstall did not commit',
      timeoutMs
    )
    assert.equal(JSON.parse(await readFile(join(source, marker), 'utf8')).version, oldVersion)
    // Current installs reuse inactive account records. Purge only the confirmed
    // uninstalled fixture so the real install API allocates a genuinely new ID.
    await purgeUninstalledFixtureRecord(cloud, item)

    const next = await cloud.publishPluginRelease({
      slug,
      version: newVersion,
      skills: { [slug]: `Copied source ${newVersion}` },
    })
    const reinstalled = await installFixture(cloud, control, slug, localDeviceId, timeoutMs, next)
    installedId = reinstalled.installedId
    assert.notEqual(installedId, item.installedId, 'Reinstall must create a new installation ID')
    const current = await until(
      () => materializedPlugin(executorHome, installedId),
      plugin => plugin?.version === newVersion,
      'The new package did not materialize',
      timeoutMs
    )
    assert.equal(
      JSON.parse(await readFile(join(current.runtime.codex_link, marker), 'utf8')).version,
      newVersion
    )
    assert.equal(JSON.parse(await readFile(join(source, marker), 'utf8')).version, newVersion)
    const skill = await readFile(join(source, 'skills', slug, 'SKILL.md'), 'utf8')
    assert.ok(
      skill.includes(`Copied source ${newVersion}`),
      'Entry still exposes the old capability'
    )
    return { pluginKey: slug, oldVersion, newVersion, ordinarySourceReinstalled: true }
  } finally {
    const current = await accountPlugin(cloud, slug)
    if (current) {
      installedId = Number(current.metadata.labels.id)
      await pluginApi(
        cloud,
        `/plugins/installed/${installedId}?device_id=${encodeURIComponent(localDeviceId)}`,
        'DELETE'
      )
      await until(
        () => materializedPlugin(executorHome, installedId),
        plugin => !plugin,
        'Copied source fixture did not uninstall',
        timeoutMs
      )
    }
  }
}
