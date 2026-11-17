import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Verify every component belongs to the selected immutable release slot. */
export async function assertReleaseComposition(control, root, version, compositions) {
  const id = (await readFile(join(root, 'active'), 'utf8')).trim()
  const slot = join(root, 'slots', id)
  const release = JSON.parse(await readFile(join(slot, 'release.json'), 'utf8'))
  const { components } = JSON.parse(await readFile(join(slot, 'prepared.json'), 'utf8'))
  const { release: actual } = JSON.parse(
    await control.command('getDesktopRuntimeDiagnostics', 'body')
  )
  assert.equal(release.version, version)
  assert.equal(actual.id, id)
  for (const [key, expected] of Object.entries({
    hostExecutable: release.executable,
    runtimeRoot: release.runtimeRoot,
    coreDshPath: components.coreDsh,
    corePluginsPath: components.weworkCorePlugins,
    executorPath: components.executor,
    codexPath: components.codex,
    dwsPath: components.dws,
  })) {
    assert.equal(resolve(actual[key]), resolve(expected), `Selected release ${key} differs`)
  }
  compositions.push({ version, ...actual, coreDsh: components.coreDsh })
}
