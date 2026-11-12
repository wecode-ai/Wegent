import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'
import { prepareMacosReleaseInstallation } from './macos-release-installation.js'
import { macosApplication, macosInstallationStage } from './macos-installation-paths.js'
import { atomicReleaseWrite, ReleaseStore, type DesktopRelease } from './release-store.js'
import { copyPhysicalRelease } from './physical-release-files.js'

const execute = promisify(execFile)

test('macOS installation paths keep the public bundle separate from per-release staging', () => {
  const executable = '/Applications/Work Name.app/Contents/MacOS/WeWork'
  expect(macosApplication(executable)).toBe('/Applications/Work Name.app')
  expect(macosInstallationStage(executable, 'release-123')).toBe(
    '/Applications/.Work Name.app.wework-release-123/Work Name.app'
  )
  expect(() => macosApplication('/Applications/tool')).toThrow('application bundle')
})

if (process.platform === 'darwin') {
  const roots: string[] = []
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })

  async function bundle(
    application: string,
    version: string,
    identifier = 'io.wecode.wework.installation-test'
  ) {
    await mkdir(join(application, 'Contents/MacOS'), { recursive: true })
    await mkdir(join(application, 'Contents/Resources'), { recursive: true })
    await copyFile('/usr/bin/true', join(application, 'Contents/MacOS/WeWork'))
    await writeFile(
      join(application, 'Contents/Resources/app.asar'),
      `signed application ${version}`
    )
    await writeFile(
      join(application, 'Contents/Info.plist'),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>WeWork</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`
    )
    await execute('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', application])
  }

  async function fixture(versioned = false, binding: 'saved' | 'previous' | 'bridge' = 'saved') {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'wework-installed-app-test-')))
    roots.push(directory)
    const store = new ReleaseStore(join(directory, 'data/releases'))
    const installed = join(directory, 'Applications/WeWork.app')
    const sourceBundle = versioned ? join(store.slot('source'), 'host/WeWork.app') : installed
    const targetBundle = join(store.slot('target'), 'host/WeWork.app')
    await bundle(installed, '1.0.0')
    if (versioned) {
      if (binding === 'bridge') await copyPhysicalRelease(installed, sourceBundle)
      else await bundle(sourceBundle, '2.0.0')
    }
    await bundle(targetBundle, '3.0.0')
    const release = (id: string, application: string, version: string): DesktopRelease => ({
      schemaVersion: 1,
      id,
      version,
      executable: join(application, 'Contents/MacOS/WeWork'),
      resources: join(application, 'Contents/Resources'),
      runtimeRoot: join(store.slot(id), 'runtimes'),
      profileRoot: join(store.slot(id), 'profile'),
      dataSchema: 1,
      readableDataSchemas: [1],
    })
    const source = release(
      'source',
      sourceBundle,
      versioned && binding !== 'bridge' ? '2.0.0' : '1.0.0'
    )
    const target = release('target', targetBundle, '3.0.0')
    await store.save(source)
    await store.save(target)
    await mkdir(source.profileRoot, { recursive: true })
    const sourcePlugins = join(store.slot(source.id), 'managed-components/composed/core')
    await mkdir(sourcePlugins, { recursive: true })
    await writeFile(join(sourcePlugins, 'index.js'), 'original source component')
    await writeFile(join(source.profileRoot, 'package.json'), '{"private":true}')
    await atomicReleaseWrite(join(store.root, 'active'), source.id)
    await atomicReleaseWrite(join(store.root, 'bridge'), source.executable)
    await atomicReleaseWrite(
      join(store.slot(source.id), 'prepared.json'),
      JSON.stringify({
        components: {
          coreDsh: join(source.resources, 'harness-runtime'),
          executor: join(source.resources, 'bin/executor'),
          weworkCorePlugins: sourcePlugins,
        },
      })
    )
    if (versioned) {
      if (binding === 'saved')
        await atomicReleaseWrite(join(store.root, 'macos-application'), installed)
      else if (binding === 'bridge')
        await atomicReleaseWrite(
          join(store.root, 'bridge'),
          join(installed, 'Contents/MacOS/WeWork')
        )
      else {
        await store.save(release('previous', installed, '1.0.0'))
        await atomicReleaseWrite(
          join(store.slot('previous'), 'prepared.json'),
          JSON.stringify({
            components: {
              coreDsh: join(installed, 'Contents/Resources/harness-runtime'),
            },
          })
        )
        await atomicReleaseWrite(join(store.root, 'previousHealthy'), 'previous')
      }
    }
    return { store, source, target, installed }
  }

  test.each(['installed', 'mapped', 'history', 'bridge'] as const)(
    'prepares signed replacement and rollback without changing the live source (%s)',
    async mode => {
      const { store, source, target, installed } = await fixture(
        mode !== 'installed',
        mode === 'history' ? 'previous' : mode === 'bridge' ? 'bridge' : 'saved'
      )
      const inode = (await stat(installed)).ino
      const installedInfo = await readFile(join(installed, 'Contents/Info.plist'))
      await prepareMacosReleaseInstallation(store, target, 'io.wecode.wework.installation-test')
      expect(await store.active()).toEqual(source)
      expect((await stat(installed)).ino).toBe(inode)
      expect(await readFile(join(installed, 'Contents/Info.plist'))).toEqual(installedInfo)
      if (mode === 'history') {
        const previous = await store.read('previous')
        expect(previous.executable).toContain(join(store.slot('previous'), 'macos-installed-host'))
        expect(
          await readFile(join(macosApplication(previous.executable), 'Contents/Info.plist'))
        ).toEqual(installedInfo)
        await execute('/usr/bin/codesign', [
          '--verify',
          '--deep',
          '--strict',
          macosApplication(previous.executable),
        ])
      }
      const prepared = await store.read(target.id)
      expect(prepared.executable).toBe(join(installed, 'Contents/MacOS/WeWork'))
      expect(prepared.macosInstallation).toMatchObject({
        bootstrapFromPayload: true,
        payloadExecutable: target.executable,
        sourceReleaseId: source.id,
      })
      const rollback = await store.read(prepared.macosInstallation!.rollbackReleaseId!)
      expect(rollback).toMatchObject({
        version: source.version,
        retainedRelease: source.id,
        profileRoot: source.profileRoot,
        componentDataDirectory: store.slot(rollback.id),
      })
      const components = JSON.parse(
        await readFile(join(store.slot(rollback.id), 'prepared.json'), 'utf8')
      ).components
      expect(components.coreDsh).toBe(join(installed, 'Contents/Resources/harness-runtime'))
      expect(components.weworkCorePlugins).toBe(
        join(store.slot(rollback.id), 'managed-components/composed/core')
      )
      expect(await realpath(components.weworkCorePlugins)).toBe(
        await realpath(join(store.slot(source.id), 'managed-components/composed/core'))
      )
      expect(await readFile(join(components.weworkCorePlugins, 'index.js'), 'utf8')).toBe(
        'original source component'
      )
      for (const item of [prepared, rollback]) {
        const stage = macosInstallationStage(item.executable, item.id)
        await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', stage])
        await execute('/usr/bin/cmp', [
          '-s',
          item.macosInstallation!.payloadExecutable,
          join(stage, 'Contents/MacOS/WeWork'),
        ])
      }
      // Cancellation keeps the original profile. The next collection owns both
      // abandoned program stages and removes them without touching the .app.
      await store.prune()
      await expect(
        stat(dirname(macosInstallationStage(prepared.executable, prepared.id)))
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await stat(join(source.profileRoot, 'package.json'))
      expect(
        await readFile(
          join(store.slot(source.id), 'managed-components/composed/core/index.js'),
          'utf8'
        )
      ).toBe('original source component')
      expect((await stat(installed)).ino).toBe(inode)
    }
  )

  test('a legacy bridge cannot select another signed application payload', async () => {
    const { store, target, installed } = await fixture(true, 'bridge')
    await bundle(installed, '9.0.0')
    await expect(
      prepareMacosReleaseInstallation(store, target, 'io.wecode.wework.installation-test')
    ).rejects.toThrow()
    expect((await store.read(target.id)).macosInstallation).toBeUndefined()
  })

  test('a different installed identity cannot be prepared or overwritten', async () => {
    const { store, target, installed } = await fixture()
    const before = await readFile(join(installed, 'Contents/Info.plist'))
    await expect(
      prepareMacosReleaseInstallation(store, target, 'io.other.application')
    ).rejects.toThrow('does not match')
    expect(await readFile(join(installed, 'Contents/Info.plist'))).toEqual(before)
    expect(basename((await store.active())!.executable)).toBe('WeWork')
  })

  test('preparation does not remove a stage owned by another store', async () => {
    const { store, source, target, installed } = await fixture()
    const before = await readFile(join(installed, 'Contents/Info.plist'))
    const stage = macosInstallationStage(join(installed, 'Contents/MacOS/WeWork'), target.id)
    await mkdir(stage, { recursive: true })
    await writeFile(join(stage, 'foreign-owner'), 'retain this directory')
    await atomicReleaseWrite(
      join(dirname(stage), 'release-owner.json'),
      JSON.stringify({
        schemaVersion: 1,
        storeRoot: '/another/store',
        releaseId: target.id,
      })
    )
    await expect(
      prepareMacosReleaseInstallation(store, target, 'io.wecode.wework.installation-test')
    ).rejects.toThrow('another owner')
    expect(await readFile(join(stage, 'foreign-owner'), 'utf8')).toBe('retain this directory')
    expect(await store.active()).toEqual(source)
    expect(await readFile(join(installed, 'Contents/Info.plist'))).toEqual(before)
  })
}
