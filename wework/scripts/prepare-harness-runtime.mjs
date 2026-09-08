import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { constants as zlibConstants } from 'node:zlib'
import { spawn } from 'node:child_process'
import { create, extract } from 'tar'

import {
  macosSigningFingerprint,
  signPreparedMacOsBinaries,
} from './lib/deepseek-harness-signing.mjs'
import { wrapWindowsScriptCommand } from './child-process-command.mjs'
import { pruneHarnessRuntime } from './lib/harness-runtime-pruning.mjs'
import { assertPortableHarnessRuntime } from './lib/portable-runtime.mjs'
import { acquireProcessLock } from './lib/process-lock.mjs'
import {
  fetchOptionalPublishedDescriptor,
  fetchPublishedResource,
  PublishedRuntimeUnavailableError,
} from './lib/published-runtime-fetch.mjs'
import { resolveHarnessRuntimeCachePaths } from './lib/harness-runtime-cache.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const coreDshVersion = '0.1.1-rc.2'
const workbenchDshVersions = new Set(['0.1.0-rc.8'])
const source = path.join(root, 'harness-runtime')
const runtimesDirectory = path.join(source, 'runtimes')
const pluginsDirectory = path.join(source, 'plugins')
const targetDirectory = path.join(root, 'resources', 'bundled-harness-runtime')
const catalogPath = path.join(targetDirectory, 'runtimes.json')
const placeholder = path.join(targetDirectory, '.resource-placeholder')
const {
  assetDirectory,
  cacheRoot: cacheDirectory,
  materializedRoot,
  prepareLockPath,
} = resolveHarnessRuntimeCachePaths(root)
const sharedFiles = ['.npmrc', 'pnpm-workspace.yaml']
const archiveFormatVersion = 'dsh-runtime-tar-gzip-v7'
const materializeRequested = process.argv.includes('--materialize')
const skipRemoteReuse = process.env.WEWORK_HARNESS_RUNTIME_SKIP_REMOTE_REUSE === '1'
const baseUrl = (
  process.env.WEWORK_HARNESS_RUNTIME_BASE_URL?.trim() ||
  'https://github.com/wecode-ai/Wegent/releases/download/wework-updater'
).replace(/\/+$/, '')
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

async function listFiles(directory, relative = '') {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const child = path.join(relative, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(directory, child)))
    } else if (entry.isFile()) {
      files.push(child)
    }
  }
  return files.sort()
}

function run(command, args, cwd, environment = {}) {
  return new Promise((resolve, reject) => {
    const resolved = wrapWindowsScriptCommand(command, args)
    const child = spawn(resolved.command, resolved.args, {
      cwd,
      env: { ...process.env, ...environment },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}

function runtimePlatform() {
  const platform = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform]
  const architecture = { arm64: 'arm64', x64: 'x64' }[process.arch]
  if (!platform || !architecture) {
    throw new Error(`Unsupported Harness runtime target: ${process.platform}-${process.arch}`)
  }
  return `${platform}-${architecture}`
}

async function sha256(pathname) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(pathname), hash)
  return hash.digest('hex')
}

async function resetTargetDirectory() {
  await rm(targetDirectory, { recursive: true, force: true })
  await mkdir(targetDirectory, { recursive: true })
  await writeFile(placeholder, '')
}

async function runtimeSources() {
  const pluginFiles = await listFiles(pluginsDirectory)
  const sharedEntries = await Promise.all(
    sharedFiles.map(async name => ({ name, content: await readFile(path.join(source, name)) }))
  )
  const pluginEntries = await Promise.all(
    pluginFiles.map(async name => ({
      name: path.join('plugins', name),
      content: await readFile(path.join(pluginsDirectory, name)),
    }))
  )
  const runtimeDirectories = (await readdir(runtimesDirectory, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  return Promise.all(
    runtimeDirectories.map(async directory => {
      const runtimeRoot = path.join(runtimesDirectory, directory)
      const packageContent = await readFile(path.join(runtimeRoot, 'package.json'))
      const lockContent = await readFile(path.join(runtimeRoot, 'pnpm-lock.yaml'))
      const packageJson = JSON.parse(packageContent.toString('utf8'))
      const dshVersion = packageJson.dependencies?.['@deepseek-ai/dsh']
      if (typeof dshVersion !== 'string' || dshVersion !== packageJson.version) {
        throw new Error(`${directory}/package.json must pin DSH to its package version`)
      }
      return {
        dshVersion,
        role:
          dshVersion === coreDshVersion
            ? 'core'
            : workbenchDshVersions.has(dshVersion)
              ? 'workbench'
              : 'legacy',
        runtimeRoot,
        entries: [
          { name: 'package.json', content: packageContent },
          { name: 'pnpm-lock.yaml', content: lockContent },
          ...sharedEntries,
          ...pluginEntries,
        ],
        pluginFiles,
      }
    })
  )
}

function runtimeIdentity(runtime) {
  const sourceFingerprint = createHash('sha256')
    .update(archiveFormatVersion)
    .update('\0')
    .update(process.versions.modules)
    .update('\0')
    .update(macosSigningFingerprint(process.platform, process.env.APPLE_SIGNING_IDENTITY))
    .update('\0')
    .update(
      runtime.entries.map(entry => `${entry.name}\0${entry.content.toString('base64')}`).join('\0')
    )
    .digest('hex')
  const safeVersion = runtime.dshVersion.replace(/[^0-9A-Za-z.-]/g, '-')
  const assetName = `harness-runtime-${runtimePlatform()}-dsh-${safeVersion}-${sourceFingerprint}.tar.gz`
  return {
    ...runtime,
    sourceFingerprint,
    assetName,
    assetPath: path.join(assetDirectory, assetName),
    descriptorName: assetName.replace(/\.tar\.gz$/, '.json'),
  }
}

function validateDescriptor(descriptor, runtime) {
  const downloadUrl = `${baseUrl}/${runtime.assetName}`
  if (
    descriptor.dshVersion !== runtime.dshVersion ||
    descriptor.role !== runtime.role ||
    descriptor.sourceFingerprint !== runtime.sourceFingerprint ||
    descriptor.assetName !== runtime.assetName ||
    descriptor.downloadUrl !== downloadUrl ||
    typeof descriptor.archiveSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(descriptor.archiveSha256) ||
    typeof descriptor.archiveBytes !== 'number' ||
    descriptor.archiveBytes <= 0
  ) {
    throw new Error(`Published Harness runtime descriptor is invalid: ${runtime.descriptorName}`)
  }
  return descriptor
}

async function ensurePublishedAsset(descriptor, runtime) {
  let valid = false
  try {
    valid =
      (await stat(runtime.assetPath)).size === descriptor.archiveBytes &&
      (await sha256(runtime.assetPath)) === descriptor.archiveSha256
  } catch {
    // Download or repair the immutable cached asset below.
  }
  if (valid) return

  const response = await fetchPublishedResource(descriptor.downloadUrl)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch published Harness runtime asset: ${response.status}`)
  }
  const temporary = `${runtime.assetPath}.${process.pid}.part`
  await rm(temporary, { force: true })
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary))
    if (
      (await stat(temporary)).size !== descriptor.archiveBytes ||
      (await sha256(temporary)) !== descriptor.archiveSha256
    ) {
      throw new Error('Published Harness runtime asset failed integrity verification')
    }
    await rm(runtime.assetPath, { force: true })
    await rename(temporary, runtime.assetPath)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function reusePublishedRuntime(runtime) {
  if (skipRemoteReuse) return null
  const response = await fetchOptionalPublishedDescriptor(`${baseUrl}/${runtime.descriptorName}`)
  if (!response) return null
  if (!response.ok) {
    throw new Error(`Failed to fetch published Harness runtime descriptor: ${response.status}`)
  }
  const descriptor = validateDescriptor(await response.json(), runtime)
  try {
    await ensurePublishedAsset(descriptor, runtime)
  } catch (error) {
    if (!(error instanceof PublishedRuntimeUnavailableError)) throw error
    console.warn(`${error.message}; building the runtime locally`)
    return null
  }
  await writeFile(
    path.join(assetDirectory, runtime.descriptorName),
    `${JSON.stringify(descriptor, null, 2)}\n`
  )
  console.log(`Reused published Harness runtime: ${runtime.assetName}`)
  return descriptor
}

async function materializeRuntime(runtime, descriptor) {
  const destination = path.join(materializedRoot, descriptor.sourceFingerprint)
  const identityPath = path.join(destination, 'runtime.json')
  try {
    const current = JSON.parse(await readFile(identityPath, 'utf8'))
    if (
      current.sourceFingerprint === descriptor.sourceFingerprint &&
      current.dshVersion === descriptor.dshVersion
    ) {
      return
    }
  } catch {
    // Materialize or repair the development runtime below.
  }
  const temporary = `${destination}-${process.pid}`
  await rm(temporary, { recursive: true, force: true })
  await mkdir(temporary, { recursive: true })
  try {
    await extract({
      cwd: temporary,
      file: runtime.assetPath,
      strict: true,
    })
    await rm(destination, { recursive: true, force: true })
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function pruneMaterializedRuntimes(descriptors) {
  const retained = new Set(descriptors.map(descriptor => descriptor.sourceFingerprint))
  let entries
  try {
    entries = await readdir(materializedRoot, { withFileTypes: true })
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter(entry => entry.isDirectory() && !retained.has(entry.name))
      .map(entry =>
        rm(path.join(materializedRoot, entry.name), {
          recursive: true,
          force: true,
        })
      )
  )
}

async function buildRuntime(runtime) {
  const staging = path.join(
    cacheDirectory,
    `wework-harness-runtime-${runtime.dshVersion}-${process.pid}`
  )
  const temporaryArchive = `${runtime.assetPath}.${process.pid}.tar.gz`
  try {
    await rm(staging, { recursive: true, force: true })
    await rm(temporaryArchive, { force: true })
    await mkdir(staging, { recursive: true })
    for (const entry of runtime.entries) {
      const destination = path.join(staging, entry.name)
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(destination, entry.content)
    }
    await run(
      pnpmCommand,
      [
        'install',
        '--prod',
        '--frozen-lockfile',
        '--virtual-store-dir=node_modules/.pnpm',
        '--package-import-method=copy',
        '--config.enable-global-virtual-store=false',
        ...(process.platform === 'win32' ? ['--config.node-linker=hoisted'] : []),
      ],
      staging
    )
    const pruned = await pruneHarnessRuntime(staging, runtimePlatform())
    console.log(
      `Pruned Harness runtime ${runtime.dshVersion}: ${pruned.directories} directories, ${pruned.files} non-runtime files`
    )
    await assertPortableHarnessRuntime(staging)
    await writeFile(
      path.join(staging, 'runtime.json'),
      `${JSON.stringify(
        {
          dshVersion: runtime.dshVersion,
          role: runtime.role,
          sourceFingerprint: runtime.sourceFingerprint,
        },
        null,
        2
      )}\n`
    )
    await writeFile(path.join(staging, '.resource-placeholder'), '')
    await signPreparedMacOsBinaries(staging)

    await create(
      {
        cwd: staging,
        file: temporaryArchive,
        gzip: { level: zlibConstants.Z_BEST_SPEED },
        portable: true,
        strict: true,
      },
      ['.']
    )
    const descriptor = {
      dshVersion: runtime.dshVersion,
      role: runtime.role,
      sourceFingerprint: runtime.sourceFingerprint,
      archiveSha256: await sha256(temporaryArchive),
      archiveBytes: (await stat(temporaryArchive)).size,
      downloadUrl: `${baseUrl}/${runtime.assetName}`,
      assetName: runtime.assetName,
    }
    await rm(runtime.assetPath, { force: true })
    await rename(temporaryArchive, runtime.assetPath)
    await writeFile(
      path.join(assetDirectory, runtime.descriptorName),
      `${JSON.stringify(descriptor, null, 2)}\n`
    )
    console.log(`Prepared Harness runtime asset: ${runtime.assetPath}`)
    return descriptor
  } finally {
    await rm(staging, { recursive: true, force: true })
    await rm(temporaryArchive, { force: true })
  }
}

await mkdir(assetDirectory, { recursive: true })
const releasePrepareLock = await acquireProcessLock(prepareLockPath)
try {
  if (process.argv.includes('--clean')) {
    await resetTargetDirectory()
    process.exitCode = 0
  } else {
    if (process.env.WEWORK_HARNESS_RUNTIME_URL?.trim()) {
      throw new Error(
        'WEWORK_HARNESS_RUNTIME_URL cannot address multiple DSH versions; use WEWORK_HARNESS_RUNTIME_BASE_URL'
      )
    }

    const runtimes = (await runtimeSources()).map(runtimeIdentity)
    if (runtimes.length === 0) {
      throw new Error('Harness runtime must declare at least one DSH version')
    }
    const descriptors = await Promise.all(
      runtimes.map(async runtime => {
        let descriptor = null
        try {
          const cached = JSON.parse(
            await readFile(path.join(assetDirectory, runtime.descriptorName), 'utf8')
          )
          await access(runtime.assetPath)
          descriptor = validateDescriptor(cached, runtime)
          await ensurePublishedAsset(descriptor, runtime)
        } catch {
          descriptor = await reusePublishedRuntime(runtime)
        }
        descriptor ??= await buildRuntime(runtime)
        if (materializeRequested) {
          await materializeRuntime(runtime, descriptor)
        }
        return descriptor
      })
    )

    await resetTargetDirectory()
    await writeFile(catalogPath, `${JSON.stringify({ runtimes: descriptors }, null, 2)}\n`)
    if (materializeRequested) {
      await mkdir(materializedRoot, { recursive: true })
      await pruneMaterializedRuntimes(descriptors)
      await writeFile(
        path.join(materializedRoot, 'runtimes.json'),
        `${JSON.stringify({ runtimes: descriptors }, null, 2)}\n`
      )
      console.log(`Harness runtime root: ${materializedRoot}`)
    }
  }
} finally {
  await releasePrepareLock()
}
