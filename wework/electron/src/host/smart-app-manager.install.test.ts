import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as workbenchDshRuntime from '../runtime/workbench-dsh-runtime.js'
import { WorkbenchRuntimeManager } from '../runtime/workbench-runtime.js'
import {
  createManager,
  createSmartAppArchive,
  validManifest,
} from './smart-app-manager.test-helpers.js'

vi.mock('electron', () => ({
  net: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) },
}))

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('SmartAppManager installation runtime ownership', () => {
  test.each([null, 42])(
    'preserves the live installation until it is stopped (marketplace id: %s)',
    async smartAppId => {
      const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-live-install-'))
      roots.push(root)
      const runtimes = new WorkbenchRuntimeManager()
      const close = vi.fn((id: string) => runtimes.close(id))
      const manager = createManager(
        root,
        undefined,
        {},
        {
          open: input => runtimes.open(input),
          close,
          runningTabIds: () => new Set(runtimes.list().map(item => item.tabId)),
        }
      )
      const launch = vi.spyOn(workbenchDshRuntime, 'prepareWorkbenchDshLaunch').mockResolvedValue({
        command: process.execPath,
        entry: 'fixture',
        args: [
          '-e',
          `const server = require('node:http').createServer((_, response) => response.end('ready'))
           server.listen(0, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port))`,
        ],
        cwd: root,
        dshHome: root,
        environment: {},
        profile: 'fixture',
        url: 'http://127.0.0.1:0/',
        version: '0.1.0-rc.8',
        sourceFingerprint: 'fixture',
      })
      try {
        const archivePath = await createSmartAppArchive(root, validManifest())
        const preview = await manager.preview(archivePath)
        const installed = await manager.install({
          archivePath,
          expectedSha256: preview.sha256,
          modelKey: 'original-model',
          smartAppId,
          releaseId: smartAppId === null ? null : 1,
        })
        const started = await manager.start({ installationId: installed.id })
        const runtimeId = `smart-app:${installed.id}`
        expect(await (await fetch(started.webUrl!)).text()).toBe('ready')

        const registryPath = join(root, 'data', 'harness-apps', 'installations.json')
        await writeFile(registryPath, `${JSON.stringify([{ ...started, state: 'installed' }])}\n`)
        const unrelatedArchive = await createSmartAppArchive(root, {
          ...validManifest(),
          name: 'unrelated-app',
        })
        const unrelatedPreview = await manager.preview(unrelatedArchive)
        await expect(
          manager.install({
            archivePath: unrelatedArchive,
            expectedSha256: unrelatedPreview.sha256,
          })
        ).resolves.toMatchObject({ id: 'unrelated-app', state: 'installed' })

        const registryBefore = await readFile(registryPath, 'utf8')
        const manifestBefore = await readFile(join(installed.packagePath, 'plugin-manifest.json'))
        const packageBefore = await readFile(join(installed.packagePath, 'app', 'package.json'))
        const nextManifest = { ...validManifest(), version: '1.1.0' }
        const nextArchive = await createSmartAppArchive(root, nextManifest)
        const nextPreview = await manager.preview(nextArchive)
        const nextInput = {
          archivePath: nextArchive,
          expectedSha256: nextPreview.sha256,
          modelKey: 'replacement-model',
          smartAppId,
          releaseId: smartAppId === null ? null : 2,
        }
        await expect(manager.install(nextInput)).rejects.toThrow(
          'Stop the Smart app before installing a new version'
        )
        expect(await readFile(registryPath, 'utf8')).toBe(registryBefore)
        expect(await readFile(join(installed.packagePath, 'plugin-manifest.json'))).toEqual(
          manifestBefore
        )
        expect(await readFile(join(installed.packagePath, 'app', 'package.json'))).toEqual(
          packageBefore
        )
        await expect(
          stat(join(dirname(installed.packagePath), nextManifest.version))
        ).rejects.toMatchObject({
          code: 'ENOENT',
        })
        expect(close).not.toHaveBeenCalled()
        expect(runtimes.get(runtimeId)).toMatchObject({ url: started.webUrl })

        await manager.stop(installed.id)
        expect(close).toHaveBeenCalledExactlyOnceWith(runtimeId)
        expect(runtimes.get(runtimeId)).toBeNull()
        await expect(manager.install(nextInput)).resolves.toMatchObject({
          id: installed.id,
          manifest: nextManifest,
          modelKey: 'replacement-model',
          state: 'installed',
          webUrl: null,
        })
        const replacementManifest = JSON.parse(
          await readFile(
            join(dirname(installed.packagePath), '1.1.0', 'plugin-manifest.json'),
            'utf8'
          )
        )
        expect(replacementManifest).toEqual(nextManifest)
      } finally {
        await runtimes.stop()
        launch.mockRestore()
      }
    }
  )
})
