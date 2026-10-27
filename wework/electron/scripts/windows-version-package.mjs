import { ZipArchive } from 'archiver'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'

// Build tools inspect physical ASAR files, including when run under Electron's Node mode.
process.noAsar = true

export const WINDOWS_UPDATE_SCHEMA_VERSION = 2
export const WINDOWS_DATA_SCHEMA_VERSION = 1
export const WINDOWS_INITIAL_UPDATE_STATE = 'initial-update-state.json'

export async function finalizeWindowsVersionPackage({
  appOutDir,
  version,
  arch = 'x64',
  executableName = 'WeWork',
  launcherPath,
}) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid Windows package version: ${version}`)
  }
  if (arch !== 'x64') throw new Error(`Unsupported Windows package architecture: ${arch}`)
  await requireFile(join(appOutDir, `${executableName}.exe`))
  await requireFile(launcherPath)
  const launcherBytes = await readFile(launcherPath)
  const staging = `${appOutDir}.version-staging`
  await mkdir(staging)
  // Electron and its native modules have already been signed. Moving preserves those bytes.
  for (const entry of await readdir(appOutDir)) {
    await rename(join(appOutDir, entry), join(staging, entry))
  }
  const release = await writeWindowsReleaseManifest({
    directory: staging,
    version,
    arch,
    entryPoint: `${executableName}.exe`,
  })
  const manifestBytes = await readFile(join(staging, 'release.json'))
  const identifier = `${version}-${createHash('sha256').update(manifestBytes).digest('hex').slice(0, 16)}`
  const versionPath = `versions/${identifier}`
  await mkdir(join(appOutDir, 'versions'))
  await rename(staging, join(appOutDir, versionPath))
  const launcher = join(appOutDir, `${executableName}.exe`)
  await writeFile(launcher, launcherBytes)
  await writeFile(
    join(appOutDir, WINDOWS_INITIAL_UPDATE_STATE),
    `${JSON.stringify(
      {
        schemaVersion: WINDOWS_UPDATE_SCHEMA_VERSION,
        active: { version, path: versionPath },
        dataSchemaVersion: WINDOWS_DATA_SCHEMA_VERSION,
      },
      null,
      2
    )}\n`
  )
  return { release, versionPath, launcher }
}

export async function writeWindowsReleaseManifest({
  directory,
  version,
  arch = 'x64',
  entryPoint = 'WeWork.exe',
}) {
  await requireFile(join(directory, entryPoint))
  const files = []
  for (const path of await packageFiles(directory)) {
    if (path === 'release.json') continue
    const fullPath = join(directory, path)
    files.push({ path, size: (await stat(fullPath)).size, sha256: await hashFile(fullPath) })
  }
  const release = {
    schemaVersion: WINDOWS_UPDATE_SCHEMA_VERSION,
    version,
    platform: 'windows',
    arch,
    dataSchemaVersion: WINDOWS_DATA_SCHEMA_VERSION,
    entryPoint,
    files,
  }
  await writeFile(join(directory, 'release.json'), `${JSON.stringify(release, null, 2)}\n`)
  return release
}

export async function createWindowsUpdateArchive({ installRoot, outputFile }) {
  const state = JSON.parse(await readFile(join(installRoot, WINDOWS_INITIAL_UPDATE_STATE), 'utf8'))
  if (
    state.schemaVersion !== WINDOWS_UPDATE_SCHEMA_VERSION ||
    !/^versions\/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-[a-f0-9]{16}$/.test(state.active?.path ?? '')
  ) {
    throw new Error('Windows package is missing a valid initial update state')
  }
  const directory = join(installRoot, state.active.path)
  const releaseBytes = await readFile(join(directory, 'release.json'))
  const release = JSON.parse(releaseBytes)
  if (
    release.schemaVersion !== WINDOWS_UPDATE_SCHEMA_VERSION ||
    release.version !== state.active.version ||
    state.active.path !==
      `versions/${release.version}-${createHash('sha256').update(releaseBytes).digest('hex').slice(0, 16)}`
  ) {
    throw new Error('Windows package release and initial update state disagree')
  }
  const paths = await packageFiles(directory)
  const manifestPaths = release.files.map(file => file.path)
  if (
    JSON.stringify(paths.filter(path => path !== 'release.json')) !== JSON.stringify(manifestPaths)
  ) {
    throw new Error('Windows package files changed after release finalization')
  }
  for (const file of release.files) {
    const path = join(directory, file.path)
    if ((await stat(path)).size !== file.size || (await hashFile(path)) !== file.sha256) {
      throw new Error(`Windows package bytes changed after signing: ${file.path}`)
    }
  }
  await mkdir(dirname(outputFile), { recursive: true })
  const archive = new ZipArchive({ zlib: { level: 6 } })
  const complete = pipeline(archive, createWriteStream(outputFile, { flags: 'wx' }))
  for (const path of paths) {
    archive.file(join(directory, path), { name: path })
  }
  await Promise.all([archive.finalize(), complete])
  return { release, outputFile }
}

async function packageFiles(root, directory = root) {
  const paths = []
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  )) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...(await packageFiles(root, path)))
    else if (entry.isFile()) paths.push(relative(root, path).split(sep).join('/'))
    else throw new Error(`Windows version packages cannot contain links: ${path}`)
  }
  return paths
}

async function hashFile(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function requireFile(path) {
  if (!(await stat(resolve(path))).isFile()) {
    throw new Error(`Required Windows package file is unavailable: ${basename(path)}`)
  }
}
