import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { constants as zlibConstants, createGzip } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import { wrapWindowsScriptCommand } from './child-process-command.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'harness-runtime')
const targetDirectory = path.join(root, 'src-tauri', 'bundled-deepseek-harness')
const archive = path.join(targetDirectory, 'runtime.tar.gz')
const metadata = path.join(targetDirectory, 'runtime.json')
const placeholder = path.join(targetDirectory, '.resource-placeholder')
const cacheDirectory = path.join(root, 'node_modules', '.cache')
const staging = path.join(cacheDirectory, `wework-deepseek-harness-${process.pid}`)
const temporaryArchive = path.join(cacheDirectory, `wework-deepseek-harness-${process.pid}.tar.gz`)
const temporaryTar = temporaryArchive.slice(0, -3)
const temporaryMetadata = `${temporaryArchive}.json`
const sourceFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']
const archiveFormatVersion = 'tar-gzip-fast-v1'

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

if (process.argv.includes('--clean')) {
  await resetTargetDirectory()
  process.exit(0)
}

const sourceContents = await Promise.all(sourceFiles.map(file => readFile(path.join(source, file))))
const sourceFingerprint = createHash('sha256')
  .update(archiveFormatVersion)
  .update('\0')
  .update(process.version)
  .update('\0')
  .update(sourceContents.map(content => content.toString('base64')).join('\0'))
  .digest('hex')
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

try {
  const currentMetadata = JSON.parse(await readFile(metadata, 'utf8'))
  await access(archive)
  if (currentMetadata.sourceFingerprint === sourceFingerprint) {
    console.log('DeepSeek Harness runtime is up to date')
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
  await run(pnpmCommand, ['install', '--prod', '--frozen-lockfile'], staging)

  const nodeDirectory = path.join(staging, 'node', 'bin')
  await mkdir(nodeDirectory, { recursive: true })
  await cp(process.execPath, path.join(nodeDirectory, nodeName))

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

  await run('tar', ['-cf', temporaryTar, '-C', staging, '.'], root, {
    COPYFILE_DISABLE: '1',
  })
  await pipeline(
    createReadStream(temporaryTar),
    createGzip({ level: zlibConstants.Z_BEST_SPEED }),
    createWriteStream(temporaryArchive)
  )
  await writeFile(temporaryMetadata, runtimeMetadata)

  await resetTargetDirectory()
  await rename(temporaryArchive, archive)
  await rename(temporaryMetadata, metadata)
} finally {
  await rm(staging, { recursive: true, force: true })
  await rm(temporaryArchive, { force: true })
  await rm(temporaryTar, { force: true })
  await rm(temporaryMetadata, { force: true })
}
