import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { ZipArchive } from 'archiver'

import { resolveDesktopPackageLayout } from './desktop-package-layout.mjs'

const electronRequire = createRequire(new URL('../../../electron/package.json', import.meta.url))

async function rewriteApplicationVersion(versionRoot, version, failStartup) {
  const builderRequire = createRequire(electronRequire.resolve('electron-builder'))
  const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'))
  const asar = appBuilderRequire('@electron/asar')
  const archive = join(versionRoot, 'resources', 'app.asar')
  const extracted = join(versionRoot, '.e2e-asar-source')
  asar.extractAll(archive, extracted)
  const packagePath = join(extracted, 'package.json')
  const metadata = JSON.parse(await readFile(packagePath, 'utf8'))
  metadata.version = version
  await writeFile(packagePath, `${JSON.stringify(metadata, null, 2)}\n`)
  if (failStartup) {
    // A real Electron main process exits before starting its renderer/runtime.
    await writeFile(join(extracted, metadata.main), 'process.exit(71)\n')
  }
  await rm(archive)
  await rm(`${archive}.unpacked`, { recursive: true, force: true })
  await asar.createPackageWithOptions(extracted, archive, { unpack: '**/*.{node,dylib,so,dll}' })
  await rm(extracted, { recursive: true, force: true })
  const componentsPath = join(versionRoot, 'resources', 'components.json')
  const components = JSON.parse(await readFile(componentsPath, 'utf8'))
  components.appVersion = version
  components.channel = 'stable'
  await writeFile(componentsPath, `${JSON.stringify(components, null, 2)}\n`)
}

export async function prepareWindowsUpdateFixtures({ appBinary, outputRoot }) {
  assert.equal(process.platform, 'win32', 'Windows update fixtures require a real Windows build')
  const source = await resolveDesktopPackageLayout(appBinary)
  assert.ok(source.installRoot, 'Windows update fixtures require a versioned installation')
  const { finalizeWindowsVersionPackage, createWindowsUpdateArchive } =
    await import('../../../electron/scripts/windows-version-package.mjs')
  const destination = resolve(outputRoot)
  assert.notEqual(destination, source.installRoot)
  await mkdir(destination, { recursive: true })
  // The source package remains immutable; checkpoints copy it into their owned installation.
  const baselineRoot = source.installRoot
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(source.state.active.version)
  assert.ok(match, 'The baseline must have a semantic application version')
  const targetVersion = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
  const artifacts = {}
  for (const [name, failStartup] of [
    ['target', false],
    ['startup-failure', true],
  ]) {
    const installRoot = join(destination, name)
    await cp(dirname(source.versionBinary), installRoot, { recursive: true })
    await rm(join(installRoot, 'release.json'))
    await rewriteApplicationVersion(installRoot, targetVersion, failStartup)
    await finalizeWindowsVersionPackage({
      appOutDir: installRoot,
      version: targetVersion,
      arch: 'x64',
      executableName: 'WeWork',
      launcherPath: source.launchBinary,
    })
    const outputFile = join(destination, `${name}.zip`)
    await createWindowsUpdateArchive({ installRoot, outputFile })
    artifacts[name] = { ...(name === 'target' ? { installRoot } : {}), archive: outputFile }
    if (failStartup) await rm(installRoot, { recursive: true })
  }
  // Keep release.json unchanged while removing an actual required file.
  // The ZIP hash is valid, but complete-directory validation must reject it.
  const targetLayout = await resolveDesktopPackageLayout(
    join(artifacts.target.installRoot, 'WeWork.exe')
  )
  const targetRoot = dirname(targetLayout.versionBinary)
  const manifest = JSON.parse(await readFile(join(targetRoot, 'release.json'), 'utf8'))
  assert.ok(manifest.files.some(file => file.path === 'resources/app.asar'))
  const missingArchive = join(destination, 'missing-file.zip')
  const brokenZip = new ZipArchive({ zlib: { level: 6 } })
  const complete = pipeline(brokenZip, createWriteStream(missingArchive, { flags: 'wx' }))
  for (const path of ['release.json', ...manifest.files.map(file => file.path)]) {
    if (path !== 'resources/app.asar') brokenZip.file(join(targetRoot, path), { name: path })
  }
  await Promise.all([brokenZip.finalize(), complete])
  artifacts['missing-file'] = { archive: missingArchive }
  const fixture = {
    schemaVersion: 1,
    baselineRoot,
    baselineVersion: source.state.active.version,
    targetVersion,
    artifacts,
    provenance:
      'Two actual Electron package versions from the same source; not historical release fixtures',
  }
  await writeFile(join(destination, 'fixtures.json'), `${JSON.stringify(fixture, null, 2)}\n`)
  return fixture
}

export function windowsFeedForArchive(version, archiveBytes, url) {
  return {
    schemaVersion: 2,
    version,
    platform: 'windows',
    arch: 'x64',
    dataSchemaVersion: 1,
    url,
    sha512: createHash('sha512').update(archiveBytes).digest('base64'),
    size: archiveBytes.length,
    releaseDate: new Date().toISOString(),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [appBinary, outputRoot] = process.argv.slice(2)
  assert.ok(appBinary && outputRoot, 'Usage: windows-update-fixtures.mjs <application> <output>')
  await prepareWindowsUpdateFixtures({ appBinary, outputRoot })
}
