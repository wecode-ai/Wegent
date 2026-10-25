import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { testId } from './plugin-regression-fixture.mjs'

export async function refreshWithOccupiedPluginRuntime(control, fixture, timeoutMs) {
  const refresh = testId('plugins-refresh-button')
  const notice = `${testId('plugin-operation-notice')}[data-notice-kind="error"]`
  await control.command('waitFor', `${refresh}:not(:disabled)`, { timeoutMs })
  const revision = await control.command('getAttribute', refresh, {
    value: 'data-reconciliation-revision',
  })
  assert.match(revision, /^\d+$/, 'Plugin refresh must expose its reconciliation revision')
  await control.command('clickIfPresent', testId('plugin-operation-notice-dismiss'))
  await control.command('waitFor', testId('plugin-operation-notice'), {
    visible: false,
    timeoutMs,
  })
  await control.command('clickWhenEnabled', refresh, { timeoutMs })
  await control.command('waitFor', notice, {
    text: `Plugin reconciliation failed for ${fixture.slug}: PLUGIN_RUNTIME_METADATA_FAILED`,
    timeoutMs,
  })
  await control.command('waitFor', `${refresh}:not(:disabled)`, { timeoutMs })
  assert.equal(
    await control.command('getAttribute', refresh, { value: 'data-reconciliation-revision' }),
    revision,
    'An occupied runtime must not be acknowledged as a successful reconciliation'
  )
}

export function isolatedPath(root, path) {
  const suffix = relative(resolve(root), resolve(path))
  assert.ok(
    suffix && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`),
    'Plugin recovery fixtures must stay inside their isolated result directory'
  )
  return resolve(path)
}

export function relocatedPath(path, oldRoot, newRoot) {
  isolatedPath(oldRoot, path)
  return join(newRoot, relative(oldRoot, path))
}

export async function readCapabilityManifest(executorHome) {
  return JSON.parse(await readFile(join(executorHome, 'capabilities/manifest-v2.json'), 'utf8'))
}

export function pluginEntry(manifest, installedId) {
  return Object.values(manifest.plugins ?? {}).find(
    entry => Number(entry.installed_plugin_id) === Number(installedId) && entry.managed
  )
}

export async function createBusinessPackage(root, slug, version) {
  await mkdir(join(root, '.codex-plugin'), { recursive: true })
  await mkdir(join(root, 'skills', slug), { recursive: true })
  await writeFile(
    join(root, '.codex-plugin/plugin.json'),
    JSON.stringify({
      name: slug,
      version,
      description: `Recovery fixture ${slug}`,
      skills: './skills/',
    })
  )
  await writeFile(
    join(root, 'skills', slug, 'SKILL.md'),
    `---\nname: ${slug}\ndescription: Execute the recovery fixture business command\n---\n\nRun sh scripts/business.sh from this plugin's root.\n`
  )
  await mkdir(join(root, 'scripts'), { recursive: true })
  await writeFile(
    join(root, 'scripts/business.sh'),
    `printf '%s\\n' 'PLUGIN_RECOVERY_OK:${slug}:${version}'\n`
  )
  return root
}

/** Move the real installed files, deliberately retaining all recorded absolute paths. */
export async function relocateInstalledHome({ resultDir, oldHome, oldExecutor, newHome }) {
  for (const path of [oldHome, oldExecutor, newHome]) isolatedPath(resultDir, path)
  assert.equal((await lstat(oldHome)).isSymbolicLink(), false)
  assert.equal((await lstat(oldExecutor)).isSymbolicLink(), false)
  await assert.rejects(lstat(newHome), { code: 'ENOENT' })
  const newExecutor = join(newHome, 'executor')
  await rename(oldHome, newHome)
  await rename(oldExecutor, newExecutor)
  await assert.rejects(lstat(oldHome), { code: 'ENOENT' })
  await assert.rejects(lstat(oldExecutor), { code: 'ENOENT' })
  return newExecutor
}

export async function replaceOwnedRuntimeWithForeignDirectory(resultDir, path) {
  isolatedPath(resultDir, path)
  // The caller stops the application and passes a runtime created by the real install.
  await rm(path, { recursive: true, force: true })
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'unrelated-owner.txt'), 'Keep this unrelated directory intact\n')
}

export function assertCurrentRuntime(entry, { home, executorHome }) {
  assert.ok(entry, 'Managed plugin disappeared during Home recovery')
  isolatedPath(home, entry.store_path)
  isolatedPath(executorHome, entry.runtime.codex_link)
  assert.equal(entry.runtime_recovery_error, undefined, 'Plugin recovery still reports a failure')
}
