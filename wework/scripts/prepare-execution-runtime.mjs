import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { constants as zlibConstants, createGzip } from 'node:zlib'
import { spawn } from 'node:child_process'

import { macosSigningFingerprint } from './lib/deepseek-harness-signing.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resourceDirectory = path.join(root, 'src-tauri', 'bundled-execution-runtimes')
const descriptorPath = path.join(resourceDirectory, 'node.json')
const cacheDirectory = path.join(root, 'node_modules', '.cache')
const assetDirectory = path.join(cacheDirectory, 'execution-runtime-assets')
const materializedRoot = path.join(cacheDirectory, 'execution-runtime-node-dev')
const staging = path.join(cacheDirectory, `wework-node-runtime-${process.pid}`)
const temporaryArchive = path.join(cacheDirectory, `wework-node-runtime-${process.pid}.tar.gz`)
const temporaryTar = temporaryArchive.slice(0, -3)
const nodeEntitlements = path.join(root, 'scripts', 'deepseek-harness-node.entitlements.plist')
const materializeRequested = process.argv.includes('--materialize')
const archiveFormatVersion = 'node-runtime-tar-gzip-v1'

function run(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
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
    throw new Error(`Unsupported Node runtime target: ${process.platform}-${process.arch}`)
  }
  return `${platform}-${architecture}`
}

async function sha256(pathname) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(pathname), hash)
  return hash.digest('hex')
}

async function signAndValidateNode(nodePath) {
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
    await run('codesign', [...args, nodePath])
  }
  await run(nodePath, ['-e', 'process.stdout.write(process.versions.node)'])
}

async function materialize(assetPath, fingerprint) {
  const identityPath = path.join(materializedRoot, 'runtime.json')
  try {
    const identity = JSON.parse(await readFile(identityPath, 'utf8'))
    if (identity.fingerprint === fingerprint) {
      console.log(`Node runtime root: ${materializedRoot}`)
      return
    }
  } catch {
    // Materialize or repair the development runtime below.
  }
  const temporaryRoot = `${materializedRoot}-${process.pid}`
  await rm(temporaryRoot, { recursive: true, force: true })
  await mkdir(temporaryRoot, { recursive: true })
  try {
    await run('tar', ['-xzf', assetPath, '-C', temporaryRoot])
    await rm(materializedRoot, { recursive: true, force: true })
    await rename(temporaryRoot, materializedRoot)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
  console.log(`Node runtime root: ${materializedRoot}`)
}

const nodeBinaryName = process.platform === 'win32' ? 'node.exe' : 'node'
const signingFingerprint = macosSigningFingerprint(
  process.platform,
  process.env.APPLE_SIGNING_IDENTITY
)
const fingerprint = createHash('sha256')
  .update(archiveFormatVersion)
  .update('\0')
  .update(process.version)
  .update('\0')
  .update(runtimePlatform())
  .update('\0')
  .update(signingFingerprint)
  .digest('hex')
const assetName = `node-runtime-${runtimePlatform()}-${fingerprint}.tar.gz`
const assetPath = path.join(assetDirectory, assetName)
const baseUrl =
  process.env.WEWORK_EXECUTION_RUNTIME_BASE_URL?.trim() ||
  'https://github.com/wecode-ai/Wegent/releases/download/wework-updater'
const downloadUrl =
  process.env.WEWORK_NODE_RUNTIME_URL?.trim() || `${baseUrl.replace(/\/+$/, '')}/${assetName}`

try {
  const current = JSON.parse(await readFile(descriptorPath, 'utf8'))
  await access(assetPath)
  if (current.fingerprint === fingerprint && current.downloadUrl === downloadUrl) {
    console.log('Node execution runtime is up to date')
    if (materializeRequested) await materialize(assetPath, fingerprint)
    process.exit(0)
  }
} catch {
  // Prepare or repair the runtime below.
}

try {
  await rm(staging, { recursive: true, force: true })
  await rm(temporaryArchive, { force: true })
  await rm(temporaryTar, { force: true })
  await mkdir(path.join(staging, 'bin'), { recursive: true })
  const managedNode = path.join(staging, 'bin', nodeBinaryName)
  await cp(process.execPath, managedNode)
  await signAndValidateNode(managedNode)
  await writeFile(
    path.join(staging, 'runtime.json'),
    `${JSON.stringify(
      {
        id: 'node',
        version: process.version.replace(/^v/, ''),
        fingerprint,
        platform: runtimePlatform(),
      },
      null,
      2
    )}\n`
  )
  await run('tar', ['-cf', temporaryTar, '-C', staging, '.'])
  await pipeline(
    createReadStream(temporaryTar),
    createGzip({ level: zlibConstants.Z_BEST_SPEED }),
    createWriteStream(temporaryArchive)
  )

  const archiveSha256 = await sha256(temporaryArchive)
  const archiveBytes = (await stat(temporaryArchive)).size
  const descriptor = {
    id: 'node',
    version: process.version.replace(/^v/, ''),
    fingerprint,
    archiveSha256,
    archiveBytes,
    downloadUrl,
    assetName,
    installedBytes: (await stat(managedNode)).size,
  }

  await mkdir(assetDirectory, { recursive: true })
  await mkdir(resourceDirectory, { recursive: true })
  await rm(assetPath, { force: true })
  await rename(temporaryArchive, assetPath)
  await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`)
  console.log(`Prepared Node execution runtime asset: ${assetPath}`)
  if (materializeRequested) await materialize(assetPath, fingerprint)
} finally {
  await rm(staging, { recursive: true, force: true })
  await rm(temporaryArchive, { force: true })
  await rm(temporaryTar, { force: true })
}
