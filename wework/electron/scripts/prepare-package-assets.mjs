import { spawn } from 'node:child_process'
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const electronRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const weworkRoot = resolve(electronRoot, '..')
const repositoryRoot = resolve(weworkRoot, '..')
const executorRoot = join(repositoryRoot, 'executor')
const resourcesRoot = join(electronRoot, 'resources')
const sharedResourcesRoot = join(weworkRoot, 'resources')
const executorProfile = resolveExecutorProfile()

const configuredExecutorPath = process.env.WEWORK_EXECUTOR_PATH?.trim()
const [executorPath] = await Promise.all([
  configuredExecutorPath
    ? Promise.resolve(resolve(configuredExecutorPath))
    : buildExecutor(executorProfile),
  run('pnpm', ['prepare:harness-runtime', '--materialize'], weworkRoot),
  run('pnpm', ['prepare:execution-runtime', '--materialize'], weworkRoot),
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
const executorName = process.platform === 'win32' ? 'wegent-executor.exe' : 'wegent-executor'
const packagedExecutor = join(resourcesRoot, 'bin', executorName)
await cp(executorPath, packagedExecutor)
if (process.platform !== 'win32') await chmod(packagedExecutor, 0o755)

console.log(`Electron package resources: ${resourcesRoot}`)

function resolveExecutorProfile() {
  const configured = process.env.WEWORK_EXECUTOR_PROFILE?.trim() || 'release'
  if (configured === 'debug' || configured === 'release') return configured
  throw new Error(`Unsupported Wework executor profile: ${configured}`)
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
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}

function capture(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
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
