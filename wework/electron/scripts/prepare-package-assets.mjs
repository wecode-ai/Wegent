import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

import { wrapWindowsScriptCommand } from '../../scripts/child-process-command.mjs'
import {
  resolveDesktopPackageTargets,
  targetExecutableName,
} from '../../scripts/lib/desktop-package-target.mjs'
import {
  CORE_PLUGIN_DIRECTORIES,
  corePluginTarget,
} from '../../scripts/lib/core-plugin-resources.mjs'
import { resolveHarnessRuntimeCachePaths } from '../../scripts/lib/harness-runtime-cache.mjs'
import { normalizeFileViewerAssetManifest } from '../../scripts/lib/harness-runtime-metadata.mjs'

const electronRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const weworkRoot = resolve(electronRoot, '..')
const repositoryRoot = resolve(weworkRoot, '..')
const executorRoot = join(repositoryRoot, 'executor')
const resourcesRoot = join(electronRoot, 'resources')
const sharedResourcesRoot = join(weworkRoot, 'resources')
const executorProfile = resolveExecutorProfile()
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const packageTargets = resolveDesktopPackageTargets(process.env)
const packageEnvironment = {
  ...process.env,
  CARGO_BUILD_TARGET: packageTargets.cargoTarget,
  WEWORK_CODEX_TARGET: packageTargets.codexTarget,
  WEWORK_DWS_TARGET: packageTargets.dwsTarget,
}
const { assetDirectory: harnessRuntimeAssetDirectory } = resolveHarnessRuntimeCachePaths(
  weworkRoot,
  packageEnvironment
)
const configuredExecutorPath = process.env.WEWORK_EXECUTOR_PATH?.trim()
const [executorPath] = await Promise.all([
  configuredExecutorPath
    ? Promise.resolve(resolve(configuredExecutorPath))
    : buildExecutor(executorProfile, packageTargets.cargoTarget),
  run(pnpmCommand, ['prepare:codex', '--materialize'], weworkRoot, packageEnvironment),
  run(pnpmCommand, ['prepare:dws'], weworkRoot, packageEnvironment),
  run(pnpmCommand, ['prepare:harness-runtime', '--materialize'], weworkRoot, packageEnvironment),
  buildDshApp(),
])

await rm(resourcesRoot, { recursive: true, force: true })
await mkdir(join(resourcesRoot, 'bin'), { recursive: true, mode: 0o700 })
const runtimeCatalog = JSON.parse(
  await readFile(join(sharedResourcesRoot, 'bundled-harness-runtime', 'runtimes.json'), 'utf8')
)
const packagedRuntimes = runtimeCatalog.runtimes.filter(runtime =>
  ['core', 'workbench'].includes(runtime.role)
)
const harnessResources = join(resourcesRoot, 'harness-runtime')
await mkdir(harnessResources, { recursive: true, mode: 0o700 })
for (const runtime of packagedRuntimes) {
  await cp(
    join(harnessRuntimeAssetDirectory, runtime.assetName),
    join(harnessResources, runtime.assetName)
  )
}
await writeFile(
  join(harnessResources, 'runtimes.json'),
  `${JSON.stringify({ runtimes: packagedRuntimes }, null, 2)}\n`,
  { mode: 0o600 }
)
await cp(join(sharedResourcesRoot, 'bundled-plugins'), join(resourcesRoot, 'bundled-plugins'), {
  recursive: true,
})
const corePluginsRoot = join(resourcesRoot, 'wework-core-plugins')
await mkdir(corePluginsRoot, { recursive: true, mode: 0o700 })
for (const directory of CORE_PLUGIN_DIRECTORIES) {
  await cp(join(weworkRoot, 'dsh', directory), join(corePluginsRoot, corePluginTarget(directory)), {
    recursive: true,
    filter: source => !source.endsWith('.test.mjs'),
  })
}
const codexTarget = packageTargets.codexTarget
const codexSource = join(sharedResourcesRoot, 'binaries', 'codex', codexTarget)
const codexResources = join(resourcesRoot, 'codex')
await cp(codexSource, codexResources, { recursive: true })
await cp(join(sharedResourcesRoot, 'binaries', 'codex', 'legal'), join(codexResources, 'legal'), {
  recursive: true,
})
const executorName = targetExecutableName(packageTargets.cargoTarget, 'wegent-executor')
const packagedExecutor = join(resourcesRoot, 'bin', executorName)
await cp(executorPath, packagedExecutor)
if (process.platform !== 'win32') await chmod(packagedExecutor, 0o755)
const executorSha256 = await sha256(packagedExecutor)
const dwsName = targetExecutableName(packageTargets.dwsTarget, 'dws')
const packagedDws = join(resourcesRoot, 'bin', dwsName)
const dwsSourceName = targetExecutableName(
  packageTargets.dwsTarget,
  `dws-${packageTargets.dwsTarget}`
)
await cp(join(sharedResourcesRoot, 'binaries', dwsSourceName), packagedDws)
if (process.platform !== 'win32') await chmod(packagedDws, 0o755)
const electronPackage = JSON.parse(await readFile(join(electronRoot, 'package.json'), 'utf8'))
const weworkPackage = JSON.parse(await readFile(join(weworkRoot, 'package.json'), 'utf8'))
const sourceSha =
  process.env.WEWORK_SOURCE_SHA?.trim() ||
  process.env.GITHUB_SHA?.trim() ||
  (await capture('git', ['rev-parse', 'HEAD'], repositoryRoot)).trim()
if (!/^[0-9a-f]{40,64}$/.test(sourceSha)) {
  throw new Error(`Invalid Wework source SHA: ${sourceSha}`)
}
const weworkRuntimeVersion = `wework-${sourceSha.slice(0, 12)}`
const codexRuntime = JSON.parse(
  await readFile(join(codexResources, 'WEGENT_CODEX_BINARY.json'), 'utf8')
)
await writeFile(
  join(resourcesRoot, 'components.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      appVersion: electronPackage.version,
      sourceSha,
      channel: process.env.VITE_WEWORK_RELEASE_CHANNEL?.trim() || 'development',
      components: {
        electron: { version: electronPackage.devDependencies.electron },
        coreDsh: {
          version: packagedRuntimes.find(runtime => runtime.role === 'core')?.dshVersion,
          path: 'harness-runtime',
          sha256: await hashTree(harnessResources),
        },
        weworkCorePlugins: {
          version: weworkRuntimeVersion,
          path: 'wework-core-plugins',
          sha256: await hashTree(corePluginsRoot),
        },
        bundledPlugins: {
          version: weworkRuntimeVersion,
          path: 'bundled-plugins',
          sha256: await hashTree(join(resourcesRoot, 'bundled-plugins')),
        },
        executor: {
          version: weworkRuntimeVersion,
          path: `bin/${executorName}`,
          sha256: executorSha256,
        },
        codex: {
          version: codexRuntime.codexVersion,
          path: `codex/${codexRuntime.binaryPath}`,
          sha256: await sha256(join(codexResources, codexRuntime.binaryPath)),
        },
        dws: {
          version: weworkPackage.devDependencies['dingtalk-workspace-cli'],
          path: `bin/${dwsName}`,
          sha256: await sha256(packagedDws),
        },
      },
    },
    null,
    2
  )}\n`,
  { mode: 0o600 }
)

console.log(`Electron package resources: ${resourcesRoot}`)

function resolveExecutorProfile() {
  const configured = process.env.WEWORK_EXECUTOR_PROFILE?.trim() || 'release'
  if (configured === 'debug' || configured === 'release') return configured
  throw new Error(`Unsupported Wework executor profile: ${configured}`)
}

async function buildDshApp() {
  await run(pnpmCommand, ['run', 'build:dsh-app'], weworkRoot)
  const output = join(weworkRoot, 'dsh', 'app-wework', 'web')
  const manifestPath = join(output, 'flyfish-viewer-assets.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await writeFile(
    manifestPath,
    `${JSON.stringify(normalizeFileViewerAssetManifest(manifest, output), null, 2)}\n`
  )
}

async function sha256(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function hashTree(root, relative = '') {
  const hash = createHash('sha256')
  const entries = await readdir(join(root, relative), { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = join(relative, entry.name)
    if (entry.isDirectory()) {
      hash.update(`directory:${child}\0${await hashTree(root, child)}\0`)
    } else if (entry.isFile()) {
      hash.update(`file:${child}\0${await sha256(join(root, child))}\0`)
    }
  }
  return hash.digest('hex')
}

async function buildExecutor(profile, target) {
  const buildArgs = [
    'build',
    '--manifest-path',
    join(executorRoot, 'Cargo.toml'),
    ...(profile === 'release' ? ['--release'] : []),
    '--bin',
    'wegent-executor',
  ]
  if (target) buildArgs.push('--target', target)
  await run('cargo', buildArgs, repositoryRoot)
  const metadata = JSON.parse(
    await capture(
      'cargo',
      [
        'metadata',
        '--manifest-path',
        join(executorRoot, 'Cargo.toml'),
        '--format-version',
        '1',
        '--no-deps',
      ],
      repositoryRoot
    )
  )
  return join(
    metadata.target_directory,
    ...(target ? [target] : []),
    profile,
    targetExecutableName(target, 'wegent-executor')
  )
}

function run(command, args, cwd, environment = process.env) {
  return new Promise((resolvePromise, reject) => {
    const resolved = wrapWindowsScriptCommand(command, args)
    const child = spawn(resolved.command, resolved.args, {
      cwd,
      env: environment,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}

function capture(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const resolved = wrapWindowsScriptCommand(command, args)
    const child = spawn(resolved.command, resolved.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      output += String(chunk)
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise(output)
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}
