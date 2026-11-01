import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { prepareMacosReleaseInstallation } from './macos-release-installation.js'
import { macosApplication, macosInstallationStage } from './macos-installation-paths.js'
import { atomicReleaseWrite, ReleaseStore, type DesktopRelease } from './release-store.js'

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
  let tools: string
  let launcher: string

  beforeAll(async () => {
    tools = await mkdtemp(join(tmpdir(), 'wework-macos-installation-tools-'))
    launcher = join(tools, 'wework-launcher')
    await execute(
      'rustc',
      ['--edition', '2021', resolve('..', 'launcher', 'src', 'main.rs'), '-o', launcher],
      { timeout: 30_000 }
    )
  })
  afterAll(async () => {
    await rm(tools, { recursive: true, force: true })
  })
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
    await copyFile(launcher, join(application, 'Contents/Resources/wework-launcher'))
    await writeFile(
      join(application, 'Contents/Info.plist'),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>WeWork</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`
    )
    await execute('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', application])
  }

  async function fixture(versioned = false) {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'wework-installed-app-test-')))
    roots.push(directory)
    const store = new ReleaseStore(join(directory, 'data/releases'))
    const installed = join(directory, 'Applications/WeWork.app')
    const sourceBundle = versioned ? join(store.slot('source'), 'host/WeWork.app') : installed
    const targetBundle = join(store.slot('target'), 'host/WeWork.app')
    await bundle(installed, '1.0.0')
    if (versioned) await bundle(sourceBundle, '2.0.0')
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
    const source = release('source', sourceBundle, versioned ? '2.0.0' : '1.0.0')
    const target = release('target', targetBundle, '3.0.0')
    await store.save(source)
    await store.save(target)
    await mkdir(source.profileRoot, { recursive: true })
    await writeFile(join(source.profileRoot, 'package.json'), '{"private":true}')
    await atomicReleaseWrite(join(store.root, 'active'), source.id)
    await atomicReleaseWrite(join(store.root, 'bridge'), source.executable)
    await atomicReleaseWrite(
      join(store.slot(source.id), 'prepared.json'),
      JSON.stringify({
        components: {
          coreDsh: join(source.resources, 'harness-runtime'),
          executor: join(source.resources, 'bin/executor'),
        },
      })
    )
    if (versioned) await atomicReleaseWrite(join(store.root, 'macos-application'), installed)
    return { store, source, target, installed }
  }

  test.each([false, true])(
    'prepares signed replacement and rollback without changing the live source (%s)',
    async versioned => {
      const { store, source, target, installed } = await fixture(versioned)
      const inode = (await stat(installed)).ino
      await prepareMacosReleaseInstallation(store, target, 'io.wecode.wework.installation-test')
      expect(await store.active()).toEqual(source)
      expect((await stat(installed)).ino).toBe(inode)
      const { stdout } = await execute('/usr/bin/plutil', [
        '-extract',
        'CFBundleShortVersionString',
        'raw',
        join(installed, 'Contents/Info.plist'),
      ])
      expect(stdout.trim()).toBe(source.version)
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
        componentDataDirectory: store.slot(source.id),
      })
      const components = JSON.parse(
        await readFile(join(store.slot(rollback.id), 'prepared.json'), 'utf8')
      ).components
      expect(components.coreDsh).toBe(join(installed, 'Contents/Resources/harness-runtime'))
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
      expect((await stat(installed)).ino).toBe(inode)
    }
  )

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
