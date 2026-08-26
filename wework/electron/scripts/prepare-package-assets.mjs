import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

import { wrapWindowsScriptCommand } from '../../scripts/child-process-command.mjs'

const electronRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const weworkRoot = resolve(electronRoot, '..')
const repositoryRoot = resolve(weworkRoot, '..')
const executorRoot = join(repositoryRoot, 'executor')
const resourcesRoot = join(electronRoot, 'resources')
const sharedResourcesRoot = join(weworkRoot, 'resources')
const executorProfile = resolveExecutorProfile()
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const corePluginDirectories = [
  'app-wework',
  'electron-host',
  'executor-runtime',
  'terminal-runtime',
  'ui-core-apps',
  'ui-core-settings',
  'ui-plugin-center',
  'ui-applications',
  'ui-automations',
  'ui-cloud-work',
]

const configuredExecutorPath = process.env.WEWORK_EXECUTOR_PATH?.trim()
const [executorPath] = await Promise.all([
  configuredExecutorPath
    ? Promise.resolve(resolve(configuredExecutorPath))
    : buildExecutor(executorProfile),
  run(pnpmCommand, ['prepare:harness-runtime', '--materialize'], weworkRoot),
  run(pnpmCommand, ['prepare:execution-runtime', '--materialize'], weworkRoot),
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
    join(weworkRoot, 'node_modules', '.cache', 'harness-runtime-assets', runtime.assetName),
    join(harnessResources, runtime.assetName)
  )
}
await writeFile(
  join(harnessResources, 'runtimes.json'),
  `${JSON.stringify({ runtimes: packagedRuntimes }, null, 2)}\n`,
  { mode: 0o600 }
)
await cp(
  join(weworkRoot, 'node_modules', '.cache', 'execution-runtime-node-dev'),
  join(resourcesRoot, 'node-runtime'),
  { recursive: true }
)
await cp(
  join(sharedResourcesRoot, 'bundled-plugins', 'wework-personal'),
  join(resourcesRoot, 'bundled-plugins', 'wework-personal'),
  { recursive: true }
)
const corePluginsRoot = join(resourcesRoot, 'wework-core-plugins')
await mkdir(corePluginsRoot, { recursive: true, mode: 0o700 })
for (const directory of corePluginDirectories) {
  await cp(join(weworkRoot, 'dsh', directory), join(corePluginsRoot, pluginTarget(directory)), {
    recursive: true,
    filter: source => !source.endsWith('.test.mjs'),
  })
}
const codexTarget = resolveCodexTarget()
const codexSource = join(sharedResourcesRoot, 'binaries', 'codex', codexTarget)
const codexResources = join(resourcesRoot, 'codex')
await cp(codexSource, codexResources, { recursive: true })
const executorName = process.platform === 'win32' ? 'wegent-executor.exe' : 'wegent-executor'
const packagedExecutor = join(resourcesRoot, 'bin', executorName)
await cp(executorPath, packagedExecutor)
if (process.platform !== 'win32') await chmod(packagedExecutor, 0o755)
const electronPackage = JSON.parse(await readFile(join(electronRoot, 'package.json'), 'utf8'))
const nodeRuntime = JSON.parse(
  await readFile(join(resourcesRoot, 'node-runtime', 'runtime.json'), 'utf8')
)
const codexRuntime = JSON.parse(
  await readFile(join(codexResources, 'WEGENT_CODEX_BINARY.json'), 'utf8')
)
await writeFile(
  join(resourcesRoot, 'components.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      appVersion: electronPackage.version,
      components: {
        electron: { version: electronPackage.devDependencies.electron },
        node: {
          version: nodeRuntime.version,
          path: 'node-runtime',
          sha256: await hashTree(join(resourcesRoot, 'node-runtime')),
        },
        coreDsh: {
          version: packagedRuntimes.find(runtime => runtime.role === 'core')?.dshVersion,
          path: 'harness-runtime',
          sha256: await hashTree(harnessResources),
        },
        weworkCorePlugins: {
          version: electronPackage.version,
          path: 'wework-core-plugins',
          sha256: await hashTree(corePluginsRoot),
        },
        executor: {
          version: electronPackage.version,
          path: `bin/${executorName}`,
          sha256: await sha256(packagedExecutor),
        },
        codex: {
          version: codexRuntime.codexVersion,
          path: `codex/${codexRuntime.binaryPath}`,
          sha256: await sha256(join(codexResources, codexRuntime.binaryPath)),
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

function resolveCodexTarget() {
  const configured = process.env.WEWORK_CODEX_TARGET?.trim()
  if (configured) return configured
  const target = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'win32-arm64': 'aarch64-pc-windows-msvc',
    'win32-x64': 'x86_64-pc-windows-msvc',
  }[`${process.platform}-${process.arch}`]
  if (!target) throw new Error(`Unsupported Codex target: ${process.platform}-${process.arch}`)
  return target
}

function pluginTarget(directory) {
  return {
    'app-wework': 'wework-app',
    'electron-host': 'wework-electron-host',
    'executor-runtime': 'wework-executor-runtime',
    'terminal-runtime': 'wework-terminal-runtime',
    'ui-core-apps': 'wework-ui-core-apps',
    'ui-core-settings': 'wework-ui-core-settings',
    'ui-plugin-center': 'wework-ui-plugin-center',
    'ui-applications': 'wework-ui-applications',
    'ui-automations': 'wework-ui-automations',
    'ui-cloud-work': 'wework-ui-cloud-work',
  }[directory]
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

async function buildExecutor(profile) {
  const target = process.env.CARGO_BUILD_TARGET?.trim()
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
    process.platform === 'win32' ? 'wegent-executor.exe' : 'wegent-executor'
  )
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const resolved = wrapWindowsScriptCommand(command, args)
    const child = spawn(resolved.command, resolved.args, { cwd, stdio: 'inherit' })
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
