import assert from 'node:assert/strict'
import { cp, lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { refreshPluginInventory } from '../modules/plugin-inventory-state.mjs'
import {
  accountPlugin,
  assertSurfaces,
  installFixture,
  materializedPlugin,
  openPlugin,
  pathExists,
  until,
} from '../modules/plugin-regression-fixture.mjs'
import { startRealObjectStorage } from '../modules/real-object-storage.mjs'

// QA: install real account plugins, pin manual updates, then corrupt only the
// shared publication. A real enable request must redownload the pinned archive,
// retain the damaged original, preserve other plugins, and materialize the same
// version even when a newer marketplace release is already available.
export async function createDesktopScenario({
  codexHome,
  executorHome,
  resultDir,
  workbenchReadyTimeoutMs,
  captureScreenshot,
}) {
  const objectStorage = await startRealObjectStorage(resultDir, workbenchReadyTimeoutMs)
  const evidence = []
  let cloud
  let deviceId

  async function update(fixture, body) {
    const response = await fetch(
      `${cloud.backendUrl}/api/plugins/installed/${fixture.installedId}?device_id=${encodeURIComponent(deviceId)}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(workbenchReadyTimeoutMs),
      }
    )
    assert.ok(response.ok, `Real plugin state update failed: HTTP ${response.status}`)
    return response.json()
  }

  async function retainedState(fixture) {
    const entry = await materializedPlugin(executorHome, fixture.installedId)
    assert.ok(entry?.runtime?.codex_link, 'Unrelated Runtime baseline is missing')
    return {
      version: entry.version,
      checksum: entry.checksum,
      enabled: entry.enabled,
      runtime: entry.runtime,
      skill: await readFile(
        join(entry.runtime.codex_link, 'skills', fixture.slug, 'SKILL.md'),
        'utf8'
      ),
    }
  }

  return {
    requiresCloudEnvironment: true,
    backendEnv: objectStorage.backendEnv,
    setCloudEnvironment(value) {
      cloud = value
    },
    async verify(control) {
      try {
        deviceId = (await cloud.waitForConnectedAppDevice()).execution_target_id
        await cloud.stopRemoteDockerExecutorAndWaitOffline()
        const fixture = await installFixture(
          cloud,
          control,
          'package-recovery-target',
          deviceId,
          workbenchReadyTimeoutMs
        )
        const retained = await installFixture(
          cloud,
          control,
          'package-recovery-retained',
          deviceId,
          workbenchReadyTimeoutMs
        )
        await update(fixture, { updatePolicy: 'manual', enabled: false })
        const initial = await until(
          () => materializedPlugin(executorHome, fixture.installedId),
          entry => entry?.enabled === false,
          'The manual-update baseline did not reach the real Runtime',
          workbenchReadyTimeoutMs
        )
        const expectedSkill = await readFile(
          join(initial.runtime.codex_link, 'skills', fixture.slug, 'SKILL.md')
        )
        const beforeRetained = await retainedState(retained)
        await cloud.publishPluginRelease({
          slug: fixture.slug,
          version: '1.1.0',
          skills: { [fixture.slug]: 'This newer release must require the normal update action' },
        })
        const root = dirname(dirname(dirname(initial.store_path)))
        const digest = initial.checksum.replace(/^sha256:/, '')
        const metadata = join(root, 'shared', 'metadata', `plugins-${digest}.json`)
        const originalMetadata = await readFile(metadata)
        // Exercise the real directory-copy layout used when native linking fails.
        const market = join(
          codexHome,
          'plugins',
          'marketplaces',
          initial.marketplace,
          'plugins',
          initial.name
        )
        await rm(market, { recursive: true })
        await cp(initial.runtime.codex_link, market, { recursive: true })
        assert.equal((await lstat(market)).isSymbolicLink(), false)
        const extra = join(initial.store_path, 'unexpected-local-file.txt')
        const corruptedContents = 'Retain this local mutation for diagnosis'
        await writeFile(extra, corruptedContents)

        const response = await update(fixture, { enabled: true })
        assert.equal(response.spec.version, '1.0.0', 'Repair must not choose the newer release')
        const repaired = await until(
          async () => {
            const entry = await materializedPlugin(executorHome, fixture.installedId)
            if (!entry?.enabled || entry.checksum !== initial.checksum) return null
            try {
              const current = await readFile(
                join(entry.store_path, 'skills', fixture.slug, 'SKILL.md')
              )
              const runtime = await readFile(
                join(entry.runtime.codex_link, 'skills', fixture.slug, 'SKILL.md')
              )
              return current.equals(expectedSkill) &&
                runtime.equals(expectedSkill) &&
                !(await pathExists(extra))
                ? entry
                : null
            } catch (error) {
              if (error.code === 'ENOENT') return null
              throw error
            }
          },
          Boolean,
          'Verified reinstall did not recover the shared package and the pinned Runtime',
          workbenchReadyTimeoutMs
        )
        assert.equal(repaired.version, '1.0.0')
        assert.equal(repaired.store_path, initial.store_path)
        const history = join(root, 'shared', 'recovery', 'plugins', digest)
        const backups = (await readdir(history)).filter(name => name.startsWith('recovered-'))
        assert.equal(backups.length, 1, 'The corrupt publication must be retained exactly once')
        assert.equal(
          await readFile(join(history, backups[0], 'package', 'unexpected-local-file.txt'), 'utf8'),
          corruptedContents
        )
        assert.deepEqual(
          await readFile(join(history, backups[0], 'metadata.json')),
          originalMetadata
        )
        assert.deepEqual(await retainedState(retained), beforeRetained)
        const installed = await accountPlugin(cloud, fixture.slug)
        assert.equal(installed.spec.updatePolicy, 'manual')
        assert.equal(installed.spec.version, '1.0.0')
        await openPlugin(control, fixture)
        await refreshPluginInventory(control, workbenchReadyTimeoutMs)
        await assertSurfaces(control, fixture, true)
        evidence.push({
          case: 'checked-download-restores-the-current-version-and-retains-corrupt-bytes',
          version: repaired.version,
          checksum: repaired.checksum,
          backup: join(history, backups[0]),
          availableVersion: '1.1.0',
          marketplaceEntry: 'directory-copy',
        })
        await captureScreenshot(control, 'plugin-package-integrity-recovery.png', 'body')
      } finally {
        await writeFile(
          join(resultDir, 'plugin-package-integrity-recovery.json'),
          JSON.stringify({ evidence }, null, 2)
        )
      }
    },
    diagnostics: () => ({ evidence }),
    cleanup: () => objectStorage.stop(),
  }
}
