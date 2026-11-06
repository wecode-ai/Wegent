import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compareVersions } from '../electron/src/runtime/upgrade-policy.mjs'
import { UPGRADE_SUITE_VERSION } from '../e2e/desktop/upgrade-suite.mjs'
import { resolvePackagedDesktopE2EBuild } from './lib/desktop-e2e-build.mjs'
import { extractRuntimeArchive } from './lib/extract-runtime-archive.mjs'
import { hashReleaseAsset, portableDesktopRelease } from './lib/portable-desktop-release.mjs'
import { readDesktopReleaseInstallation } from './lib/published-desktop-release.mjs'

const weworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function validateRegressionVersions(source, target) {
  assert.ok(compareVersions(target, source) > 0, 'Regression target must be newer than source')
}

/** Archive a complete independently built application without changing its identity or signature. */
export async function archiveRegressionBuild(output) {
  assert.ok(['darwin', 'win32'].includes(process.platform), 'Native macOS or Windows is required')
  const { appBinary } = resolvePackagedDesktopE2EBuild(weworkRoot)
  const appRoot =
    process.platform === 'darwin' ? resolve(appBinary, '../../..') : dirname(appBinary)
  const resources = join(
    appRoot,
    ...(process.platform === 'darwin' ? ['Contents', 'Resources'] : ['resources'])
  )
  const packaged = JSON.parse(await readFile(join(resources, 'components.json'), 'utf8'))
  const release = await portableDesktopRelease({
    appRoot,
    version: packaged.appVersion,
    platform: process.platform === 'darwin' ? 'macos' : 'windows',
    arch: process.arch,
    output: resolve(output),
    fixture: true,
  })
  assert.match(release.sourceSha, /^[a-f0-9]{40,64}$/)
  await writeFile(join(output, 'release.json'), JSON.stringify(release, null, 2) + '\n')
  return release
}

async function consumeRegressionBuild(directory, installation) {
  const release = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'))
  assert.equal(release.fixture, true, 'Regression inputs must not impersonate published releases')
  assert.equal(release.platform, process.platform === 'darwin' ? 'macos' : 'windows')
  assert.equal(release.arch, process.arch)
  assert.match(release.sourceSha, /^[a-f0-9]{40,64}$/)
  compareVersions(release.version, release.version)
  assert.equal(
    release.name,
    `WeWorkRelease_${release.version}_${release.platform}_${release.arch}.tar.gz`
  )
  const archive = resolve(directory, release.name)
  assert.equal((await stat(archive)).size, release.bytes, 'Prebuilt archive size changed')
  assert.equal(await hashReleaseAsset(archive), release.sha256, 'Prebuilt archive checksum changed')
  await mkdir(installation, { recursive: true })
  await extractRuntimeArchive(archive, installation)
  return {
    ...release,
    path: archive,
    ...(await readDesktopReleaseInstallation(installation, release)),
  }
}

/** The consumer only verifies and extracts producer artifacts; it never builds or relabels them. */
export async function prepareRegressionPair(sourceDirectory, targetDirectory, output) {
  const directory = resolve(output)
  const [from, to] = await Promise.all([
    consumeRegressionBuild(sourceDirectory, join(directory, 'source')),
    consumeRegressionBuild(targetDirectory, join(directory, 'target')),
  ])
  validateRegressionVersions(from.version, to.version)
  assert.equal(from.sourceSha, to.sourceSha, 'Both regression builds must contain the same fix')
  const pair = {
    schemaVersion: 1,
    kind: 'regression',
    transport: 'default-update-route',
    applicationId: 'io.wecode.wework',
    suiteVersion: UPGRADE_SUITE_VERSION,
    channel: to.version.includes('-beta.') ? 'beta' : 'stable',
    from,
    to,
  }
  const path = join(directory, 'pair.json')
  await writeFile(path, JSON.stringify(pair, null, 2) + '\n')
  return path
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [operation, ...args] = process.argv.slice(2)
  if (operation === 'validate' && args.length === 2) validateRegressionVersions(...args)
  else if (operation === 'archive' && args.length === 1)
    console.log(JSON.stringify(await archiveRegressionBuild(args[0])))
  else if (operation === 'pair' && args.length === 3)
    console.log(await prepareRegressionPair(...args))
  else
    throw new Error(
      'Expected validate <source> <target>, archive <output>, or pair <source-dir> <target-dir> <output>'
    )
}
