import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { upgradeUserEnvironment } from './upgrade-user-environment.mjs'

const execute = promisify(execFile)

/** Reproduce a delivered launcher's cached recovery entry in an immutable slot. */
export async function useVersionedMacosRecoveryBridge(root, version) {
  if (process.platform !== 'darwin') return
  const candidates = []
  for (const id of await readdir(join(root, 'slots'))) {
    let release
    try {
      release = JSON.parse(await readFile(join(root, 'slots', id, 'release.json'), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    if (release.version === version && release.macosInstallation?.rollbackReleaseId)
      candidates.push(release)
  }
  assert.equal(candidates.length, 1, 'The failed-upgrade fixture requires one prepared target')
  const sourceId = candidates[0].macosInstallation.rollbackReleaseId
  const source = JSON.parse(await readFile(join(root, 'slots', sourceId, 'release.json'), 'utf8'))
  const bridge = source.macosInstallation.payloadExecutable
  await stat(bridge)
  const pending = join(root, 'versioned-bridge.pending')
  await writeFile(pending, bridge, { mode: 0o600 })
  await rename(pending, join(root, 'bridge'))
  console.log('[upgrade-e2e] Legacy source recovery uses its signed versioned program copy')
}

export async function macosUpgradeIdentity(executable) {
  if (process.platform !== 'darwin') return null
  const application = await realpath(resolve(executable, '../../..'))
  const { stdout } = await execute('/usr/bin/plutil', [
    '-extract',
    'CFBundleIdentifier',
    'raw',
    join(application, 'Contents/Info.plist'),
  ])
  return {
    application,
    inode: (await stat(application, { bigint: true })).ino.toString(),
    identifier: stdout.trim(),
  }
}

export async function assertMacosUpgradeIdentity(expected, root, resultDir, version) {
  if (!expected) return
  const pid = Number((await readFile(join(root, 'active-pid'), 'utf8')).trim())
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'The selected host has no real process ID')
  const { stdout } = await execute('/usr/bin/osascript', [
    '-l',
    'JavaScript',
    '-e',
    `
ObjC.import('AppKit')
const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid})
if (!app) throw new Error('The supervised application is not running')
JSON.stringify({pid:${pid}, bundle:ObjC.unwrap(app.bundleURL.path), identifier:ObjC.unwrap(app.bundleIdentifier)})
`,
  ])
  const actual = JSON.parse(stdout)
  assert.equal(
    await realpath(actual.bundle),
    expected.application,
    'The updated host registered a different macOS application URL'
  )
  assert.equal(actual.identifier, expected.identifier)
  assert.equal(
    (await stat(expected.application, { bigint: true })).ino.toString(),
    expected.inode,
    'The update replaced the outer application directory behind the Dock bookmark'
  )
  await writeFile(
    join(resultDir, `macos-application-${version}-result.json`),
    JSON.stringify({ ...actual, expected }, null, 2)
  )
}

/** Exercise the delivered source cleaner before resuming its real conversation. */
export async function pruneWithRolledBackSource(root, resultDir, homePath) {
  if (process.platform !== 'darwin') return
  const id = (await readFile(join(root, 'active'), 'utf8')).trim()
  const release = JSON.parse(await readFile(join(root, 'slots', id, 'release.json'), 'utf8'))
  if (!release.retainedRelease) return
  const executable = release.macosInstallation.payloadExecutable
  const resources = resolve(dirname(executable), '../Resources')
  const module = pathToFileURL(join(resources, 'app.asar/dist/runtime/release-store.js')).href
  const script = join(resultDir, 'verify-source-cleanup.mjs')
  await writeFile(
    script,
    `import { ReleaseStore } from ${JSON.stringify(module)}\nawait new ReleaseStore(${JSON.stringify(root)}).prune()\n`
  )
  await execute(executable, [script], {
    env: { ...upgradeUserEnvironment(process.env, homePath), ELECTRON_RUN_AS_NODE: '1' },
    timeout: 30_000,
  })
  await stat(join(release.profileRoot, 'package.json'))
  await stat(release.runtimeRoot)
  await stat(join(root, 'slots', release.retainedRelease, 'release.json'))
}
