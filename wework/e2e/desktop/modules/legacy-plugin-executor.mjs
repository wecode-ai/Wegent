import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, delimiter, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { extractRuntimeArchive } from '../../../scripts/lib/extract-runtime-archive.mjs'
import { hashReleaseAsset } from '../../../scripts/lib/portable-desktop-release.mjs'
import { fetchGithubReleaseAsset } from './github-release-asset.mjs'
import { appendProcessOutput, stopProcessGroup } from './shared.mjs'

const execute = promisify(execFile)
const repository = 'wecode-ai/Wegent'

// Immutable delivered components straddle private-store/v1 and shared-cache/v2.
// Never compile an old revision or rewrite a modern installation to seed this flow.
export const LEGACY_PLUGIN_RELEASES = [
  {
    version: '0.5.0',
    sourceSha: '0ae53dda18df4887b18f88372fb3ad7a75b2f035',
    schema: 1,
    source: 'store',
    archives: {
      'macos-arm64': '78c57e76388b53e3795a7df0c1cf50aa7a64878a86ce9e23230fe9bff51a1f45',
      'windows-x64': '4b76796c200f4ad43c00ccf5647d12b671cc40f77e6933bfc8283d9969d07f1e',
      'linux-x64': '56baa7fc636d58ee5a56ac90ffaf9c6ea9c857be32c688c8728cdc6693709985',
      'macos-x64': 'd227ce92e5b3883f77db362c84a40898ecedd8ff0d1087afa9bea4fc9d66c240',
    },
  },
  {
    version: '0.5.7',
    sourceSha: '52b14b29c471cc8868399c2791dba54cee0e9f04',
    schema: 2,
    source: 'cache',
    archives: {
      'macos-arm64': '1632b37879ad05571871163d88125441960c61726f23f8172b4c128317011416',
      'windows-x64': '751937340c5dce0cbc9f65ad01f346a12ab76d9f6a5c2dd914fdc4d2a47b87b0',
      'linux-x64': '9736421e65ec1bd430e32b017a11768611057455ed8b31dc4c0055319f1e43b9',
      'macos-x64': 'd60e1365f6662490e5fb1430423040dd2de1606524d4afb11dcde6b585e763b0',
    },
  },
]

// Both installers consume exactly this historical package. Adjacent Wework
// releases shipped different bytes under the same plugin version label.
export const HISTORICAL_PLUGIN_SOURCE = {
  version: '0.5.0',
  bundledPlugins: {
    unix: 'd7fce7acb1430c189aae1d61b8d4ffd4a702d264d85c9ae1778b27129d56e266',
    windows: 'd6b9cccc812b9fad2539560f5cb9299a17a861c28cb660120ecd8c7dffcbcdfb',
  },
}

export const HISTORICAL_PLUGIN_UPDATE = {
  version: '0.6.3',
  bundledPlugins: {
    unix: '325216afc54358ba9403e00ce3f492afbb01e5ffc6208f00ac244774270801ae',
    windows: '7a523fc5532a4c21b9d6acc46175df82cab64669c3828160b2a86f771049d44f',
  },
}

async function historicalComponent(release, component, directory, token) {
  const platform = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform]
  assert.ok(platform)
  const sha256 =
    component === 'executor'
      ? release.archives[`${platform}-${process.arch}`]
      : release.bundledPlugins[process.platform === 'win32' ? 'windows' : 'unix']
  assert.ok(sha256, 'The historical plugin regression requires a pinned native component')
  const asset = `WeworkComponent_${component}_${sha256}_${platform}_${process.arch}.tar.gz`
  await mkdir(directory, { recursive: true })
  const archive = join(directory, asset)
  try {
    assert.equal(await hashReleaseAsset(archive), sha256, 'Historical component bytes changed')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const response = await fetchGithubReleaseAsset({
      repository,
      tag: `wework-v${release.version}`,
      name: asset,
      token,
    })
    assert.ok(response.ok, `Historical plugin component download failed: HTTP ${response.status}`)
    const partial = `${archive}.${randomUUID()}.partial`
    try {
      await pipeline(response.body, createWriteStream(partial, { flags: 'wx' }))
      assert.equal(await hashReleaseAsset(partial), sha256, 'Historical component bytes changed')
      await rename(partial, archive)
    } finally {
      await rm(partial, { force: true })
    }
  }
  const installed = join(directory, 'installed')
  await mkdir(installed, { recursive: true })
  await extractRuntimeArchive(archive, installed)
  return {
    installed,
    evidence: { version: release.version, sourceSha: release.sourceSha, asset, sha256 },
  }
}

async function historicalPluginExecutor(release, directory, token) {
  const { installed, evidence } = await historicalComponent(release, 'executor', directory, token)
  const executable = join(
    installed,
    process.platform === 'win32' ? 'wegent-executor.exe' : 'wegent-executor'
  )
  return {
    executable,
    evidence: {
      ...evidence,
      binarySha256: createHash('sha256')
        .update(await readFile(executable))
        .digest('hex'),
    },
  }
}

export async function historicalPluginPackages(release, directory, token) {
  const { installed, evidence } = await historicalComponent(
    release,
    'bundledPlugins',
    directory,
    token
  )
  const packages = {}
  // Avoid conflating the disabled account install with an enabled built-in
  // marketplace installation of the same plugin key.
  for (const [role, slug, skillName, source] of [
    [
      'update',
      'smart-app-builder',
      'create-smart-app',
      'wework-personal/plugins/smart-app-builder',
    ],
    ['disabled', 'wework-plugin-example', 'hello-wework', 'wework-plugin-example'],
  ]) {
    const packageRoot = join(installed, source)
    const manifest = JSON.parse(
      await readFile(join(packageRoot, '.codex-plugin/plugin.json'), 'utf8')
    )
    assert.equal(manifest.name, slug)
    const files = {}
    for (const file of await readdir(packageRoot, { recursive: true, withFileTypes: true })) {
      assert.ok(!file.isSymbolicLink(), 'Historical fixture must not redirect package files')
      if (!file.isFile()) continue
      const path = join(file.parentPath, file.name)
      files[path.slice(packageRoot.length + 1)] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
    }
    packages[role] = { slug, version: manifest.version, skillName, packageRoot, files }
  }
  return { packages, evidence }
}

export async function prepareHistoricalPluginTools(directory) {
  await execute(
    'npm',
    [
      'install',
      '--prefix',
      directory,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      'corepack@0.34.5',
    ],
    { timeout: 120_000 }
  )
  const env = {
    ...process.env,
    PATH: `${join(directory, 'node_modules/.bin')}${delimiter}${process.env.PATH}`,
    COREPACK_HOME: join(directory, 'cache'),
    COREPACK_ENABLE_PROJECT_SPEC: '0',
    COREPACK_DEFAULT_TO_LATEST: '0',
  }
  await execute(
    process.execPath,
    [
      join(directory, 'node_modules/corepack/dist/corepack.js'),
      'install',
      '--global',
      'pnpm@11.7.0',
    ],
    { env, timeout: 120_000 }
  )
  return Object.fromEntries(
    ['PATH', 'COREPACK_HOME', 'COREPACK_ENABLE_PROJECT_SPEC', 'COREPACK_DEFAULT_TO_LATEST'].map(
      key => [key, env[key]]
    )
  )
}

export async function startHistoricalPluginExecutor({
  release,
  cloud,
  root,
  userHome,
  directory,
  token,
}) {
  const { executable, evidence } = await historicalPluginExecutor(release, directory, token)
  const deviceId = `legacy-plugins-${release.version}`
  await mkdir(root, { recursive: true })
  const evidenceDirectory = dirname(dirname(directory))
  const logPath = join(evidenceDirectory, `legacy-source-${release.version}.log`)
  const env = cloud.executorEnv({
    deviceId,
    deviceName: `Historical plugin installer ${release.version}`,
    deviceType: 'remote',
    home: root,
    codexHome: join(root, 'codex'),
    logFile: `legacy-${release.version}.log`,
  })
  env.HOME = userHome
  env.USERPROFILE = userHome
  // Retain the binary's shipped dual-runtime and capability-home defaults.
  delete env.WEGENT_PLUGIN_RUNTIME_TARGET
  const child = spawn(executable, [], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  cloud.generatedRemoteExecutors.push(child)
  await Promise.all([
    appendProcessOutput(child.stdout, logPath),
    appendProcessOutput(child.stderr, logPath),
  ])
  try {
    await cloud.waitForDevice(deviceId, logPath)
  } catch (error) {
    await stopProcessGroup(child)
    throw error
  }
  return {
    deviceId,
    evidence,
    stop: async () => {
      await stopProcessGroup(child)
      await writeFile(
        join(evidenceDirectory, `legacy-source-${release.version}-provenance.json`),
        JSON.stringify(evidence, null, 2)
      )
    },
  }
}

export async function readHistoricalPluginState(root, release) {
  const path = join(
    root,
    'capabilities',
    release.schema === 1 ? 'manifest.json' : 'manifest-v2.json'
  )
  const value = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(
    value.version,
    release.schema,
    `Shipped ${release.version} generated an unexpected schema`
  )
  return { path, value, manifestName: basename(path) }
}
