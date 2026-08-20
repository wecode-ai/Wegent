import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { constants as zlibConstants, createGzip } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import {
  macosSigningFingerprint,
  signPreparedMacOsBinaries,
} from './lib/deepseek-harness-signing.mjs'

import { wrapWindowsScriptCommand } from './child-process-command.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'harness-runtime')
const targetDirectory = path.join(root, 'src-tauri', 'bundled-deepseek-harness')
const metadata = path.join(targetDirectory, 'runtime.json')
const placeholder = path.join(targetDirectory, '.resource-placeholder')
const nodeEntitlements = path.join(root, 'scripts', 'deepseek-harness-node.entitlements.plist')
const cacheDirectory = path.join(root, 'node_modules', '.cache')
const staging = path.join(cacheDirectory, `wework-deepseek-harness-${process.pid}`)
const temporaryArchive = path.join(cacheDirectory, `wework-deepseek-harness-${process.pid}.tar.gz`)
const temporaryTar = temporaryArchive.slice(0, -3)
const temporaryMetadata = `${temporaryArchive}.json`
const sourceFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']
const pluginDirectory = 'plugins'
const archiveFormatVersion = 'tar-gzip-fast-v2'
const assetDirectory = path.join(cacheDirectory, 'deepseek-harness-runtime-assets')

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
  return files
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

async function resetTargetDirectory() {
  await rm(targetDirectory, { recursive: true, force: true })
  await mkdir(targetDirectory, { recursive: true })
  await writeFile(placeholder, '')
}

function runtimePlatform() {
  const platform = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform]
  if (!platform)
    throw new Error(`Unsupported DeepSeek Harness runtime platform: ${process.platform}`)
  const architecture = { arm64: 'arm64', x64: 'x64' }[process.arch]
  if (!architecture) {
    throw new Error(`Unsupported DeepSeek Harness runtime architecture: ${process.arch}`)
  }
  return `${platform}-${architecture}`
}

async function sha256(pathname) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(pathname), hash)
  return hash.digest('hex')
}

async function prepareManagedNode(nodePath) {
  if (process.platform === 'darwin') {
    const identity = process.env.APPLE_SIGNING_IDENTITY?.trim() || '-'
    const args = [
      '--force',
      '--options',
      'runtime',
      '--entitlements',
      nodeEntitlements,
      '--sign',
      identity,
    ]
    if (identity !== '-') args.splice(1, 0, '--timestamp')
    await run('codesign', [...args, nodePath], root)
  }
  await run(nodePath, ['-e', 'process.stdout.write(process.versions.node)'], root)
}

if (process.argv.includes('--clean')) {
  await resetTargetDirectory()
  process.exit(0)
}

const pluginFiles = await listFiles(path.join(source, pluginDirectory))
const sourceEntries = [
  ...sourceFiles.map(file => ({ name: file, path: path.join(source, file) })),
  ...pluginFiles.map(file => ({
    name: path.join(pluginDirectory, file),
    path: path.join(source, pluginDirectory, file),
  })),
  { name: 'deepseek-harness-node-entitlements', path: nodeEntitlements },
]
const sourceContents = await Promise.all(sourceEntries.map(entry => readFile(entry.path)))
const sourceFingerprint = createHash('sha256')
  .update(archiveFormatVersion)
  .update('\0')
  .update(process.version)
  .update('\0')
  .update(macosSigningFingerprint(process.platform, process.env.APPLE_SIGNING_IDENTITY))
  .update('\0')
  .update(
    sourceEntries
      .map((entry, index) => `${entry.name}\0${sourceContents[index].toString('base64')}`)
      .join('\0')
  )
  .digest('hex')
const assetName = `deepseek-harness-runtime-${runtimePlatform()}-${sourceFingerprint}.tar.gz`
const assetPath = path.join(assetDirectory, assetName)
const baseUrl =
  process.env.WEWORK_DEEPSEEK_HARNESS_RUNTIME_BASE_URL?.trim() ||
  'https://github.com/wecode-ai/Wegent/releases/download/wework-updater'
const downloadUrl =
  process.env.WEWORK_DEEPSEEK_HARNESS_RUNTIME_URL?.trim() ||
  `${baseUrl.replace(/\/+$/, '')}/${assetName}`
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

try {
  const currentMetadata = JSON.parse(await readFile(metadata, 'utf8'))
  await access(assetPath)
  if (
    currentMetadata.sourceFingerprint === sourceFingerprint &&
    currentMetadata.downloadUrl === downloadUrl
  ) {
    console.log('DeepSeek Harness runtime is up to date')
    console.log(`DeepSeek Harness runtime asset: ${assetPath}`)
    process.exit(0)
  }
} catch {
  // Prepare or repair the bundled runtime below.
}

try {
  await rm(staging, { recursive: true, force: true })
  await rm(temporaryArchive, { force: true })
  await rm(temporaryTar, { force: true })
  await rm(temporaryMetadata, { force: true })
  await mkdir(staging, { recursive: true })
  await Promise.all(sourceFiles.map(file => cp(path.join(source, file), path.join(staging, file))))
  await Promise.all(
    pluginFiles.map(async file => {
      const destination = path.join(staging, pluginDirectory, file)
      await mkdir(path.dirname(destination), { recursive: true })
      await cp(path.join(source, pluginDirectory, file), destination)
    })
  )
  await run(pnpmCommand, ['install', '--prod', '--frozen-lockfile'], staging)

  const nodeDirectory = path.join(staging, 'node', 'bin')
  await mkdir(nodeDirectory, { recursive: true })
  const managedNode = path.join(nodeDirectory, nodeName)
  await cp(process.execPath, managedNode)

  const packageJson = JSON.parse(sourceContents[0].toString('utf8'))
  const runtimeMetadata = `${JSON.stringify(
    {
      dshVersion: packageJson.dependencies['@deepseek-ai/dsh'],
      nodeVersion: process.version,
      sourceFingerprint,
    },
    null,
    2
  )}\n`
  await writeFile(path.join(staging, 'runtime.json'), runtimeMetadata)
  await writeFile(path.join(staging, '.resource-placeholder'), '')
  await signPreparedMacOsBinaries(staging)
  await prepareManagedNode(managedNode)

  await run('tar', ['-cf', temporaryTar, '-C', staging, '.'], root, {
    COPYFILE_DISABLE: '1',
  })
  await pipeline(
    createReadStream(temporaryTar),
    createGzip({ level: zlibConstants.Z_BEST_SPEED }),
    createWriteStream(temporaryArchive)
  )
  const archiveSha256 = await sha256(temporaryArchive)
  const archiveBytes = (await stat(temporaryArchive)).size
  const descriptor = `${JSON.stringify(
    {
      dshVersion: packageJson.dependencies['@deepseek-ai/dsh'],
      nodeVersion: process.version,
      sourceFingerprint,
      archiveSha256,
      archiveBytes,
      downloadUrl,
      assetName,
    },
    null,
    2
  )}\n`
  await writeFile(temporaryMetadata, descriptor)

  await mkdir(assetDirectory, { recursive: true })
  await rm(assetPath, { force: true })
  await rename(temporaryArchive, assetPath)
  await resetTargetDirectory()
  await rename(temporaryMetadata, metadata)
  console.log(`Prepared DeepSeek Harness runtime asset: ${assetPath}`)
} finally {
  await rm(staging, { recursive: true, force: true })
  await rm(temporaryArchive, { force: true })
  await rm(temporaryTar, { force: true })
  await rm(temporaryMetadata, { force: true })
}
