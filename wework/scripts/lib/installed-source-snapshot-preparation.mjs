import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { linkBundledRuntimeCache } from '../../e2e/desktop/modules/bundled-runtime-cache.mjs'
import {
  installedSourcePlugins,
  installedSourcePreparationRequest,
  installedSourceSnapshotIdentity,
} from '../../e2e/desktop/modules/installed-source-preparation.mjs'
import { saveInstalledSourceSnapshot } from '../../e2e/desktop/modules/installed-source-snapshot.mjs'
import { upgradeUserEnvironment } from '../../e2e/desktop/modules/upgrade-user-environment.mjs'
import { stopProcessGroup } from '../../e2e/desktop/process-lifecycle.mjs'
import { prepareReleaseProcess } from '../../electron/src/runtime/release-preparation-progress.mjs'

/** Generate the installed baseline with its own CLI while target programs prepare. */
export async function prepareInstalledSourceSnapshot(source, { diagnosticsDirectory }) {
  const started = performance.now()
  const base = process.platform === 'win32' ? process.env.APPDATA : tmpdir()
  assert.ok(base && isAbsolute(base), 'Source preparation requires the native data volume')
  const directory = await mkdtemp(join(base, 'wp-'))
  const logPath = join(directory, 'logs/release-preparation.log')
  try {
    const profile = join(directory, 'dsh-core/profiles/wework-core')
    const slot = join(directory, 'releases/slots/source-preparation')
    const runtimeRoot = join(directory, 'managed-runtimes/dsh')
    await mkdir(profile, { recursive: true })
    await writeFile(
      join(profile, '.wework-core-plugins.json'),
      JSON.stringify(installedSourcePlugins())
    )
    await linkBundledRuntimeCache(source.runtimeCache, runtimeRoot)
    const request = join(directory, 'request.json')
    await writeFile(request, JSON.stringify(installedSourcePreparationRequest(source, directory)))
    await prepareReleaseProcess(
      source.executable,
      [join(source.resources, 'app.asar/dist/runtime/release-preparation-cli.js'), request],
      {
        env: { ...upgradeUserEnvironment(process.env, directory), ELECTRON_RUN_AS_NODE: '1' },
        progress: { logPath },
        version: source.version,
        releaseId: 'source-preparation',
        stop: stopProcessGroup,
      }
    )
    await saveInstalledSourceSnapshot({
      cache: source.preparationCache,
      slot,
      dataDirectory: directory,
      identity: installedSourceSnapshotIdentity(source),
    })
    console.log(
      JSON.stringify({
        event: 'source-initial-preparation-ready',
        version: source.version,
        archiveSha256: source.sha256,
        elapsedMs: Math.round(performance.now() - started),
      })
    )
  } finally {
    try {
      await mkdir(diagnosticsDirectory, { recursive: true })
      await copyFile(logPath, join(diagnosticsDirectory, 'source-preparation.log'))
    } catch (error) {
      console.warn(`Cannot retain source preparation log: ${error.code ?? error.name}`)
    }
    await rm(directory, { recursive: true, force: true })
  }
}
