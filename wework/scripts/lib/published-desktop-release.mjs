import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { extractRuntimeArchive } from './extract-runtime-archive.mjs'
import { hashReleaseAsset } from './portable-desktop-release.mjs'

const execute = promisify(execFile)
const VERSION = /^\d+\.\d+\.\d+(?:-beta\.[1-9]\d*)?$/

async function downloadAsset(repository, tag, name, destination) {
  await execute(
    'gh',
    ['release', 'download', tag, '--repo', repository, '--pattern', name, '--output', destination],
    { timeout: 120_000 }
  )
}

function validateRelease(release, { version, platform, arch }) {
  if (
    release.version !== version ||
    release.platform !== platform ||
    release.arch !== arch ||
    release.fixture !== false ||
    release.name !== `WeWorkRelease_${version}_${platform}_${arch}.tar.gz` ||
    !/^[a-f0-9]{64}$/.test(release.sha256) ||
    !/^[a-f0-9]{40,64}$/.test(release.sourceSha) ||
    !Number.isSafeInteger(release.bytes) ||
    release.bytes <= 0 ||
    !Number.isSafeInteger(release.dataSchema) ||
    release.dataSchema < 1 ||
    !Array.isArray(release.readableDataSchemas) ||
    release.readableDataSchemas.some(value => !Number.isSafeInteger(value) || value < 1) ||
    !release.readableDataSchemas.includes(release.dataSchema) ||
    (release.afterStopPreparation !== undefined && release.afterStopPreparation !== 1)
  )
    throw new Error('Published desktop release identity is invalid')
}

async function verifyArchive(path, release) {
  if (
    (await stat(path)).size !== release.bytes ||
    (await hashReleaseAsset(path)) !== release.sha256
  )
    throw new Error('The immutable published desktop archive changed')
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function releasePath(root, path) {
  if (typeof path !== 'string' || isAbsolute(path))
    throw new Error('Published desktop descriptor has an invalid path')
  const location = resolve(root, path)
  const child = relative(root, location)
  if (
    !child ||
    child === '..' ||
    child.startsWith('../') ||
    child.startsWith('..\\') ||
    isAbsolute(child)
  )
    throw new Error('Published desktop descriptor escapes its installation')
  const physical = await realpath(location)
  const physicalChild = relative(await realpath(root), physical)
  if (
    physicalChild === '..' ||
    physicalChild.startsWith('../') ||
    physicalChild.startsWith('..\\') ||
    isAbsolute(physicalChild)
  )
    throw new Error('Published desktop descriptor follows a link outside its installation')
  // Electron resolves the application location physically (for example /tmp on
  // macOS). Its shipped preparation entry compares this exact resource path.
  return physical
}

async function extractPublishedArchive(archive, root, release) {
  if (!(await exists(root))) {
    const pending = `${root}.extract-${randomUUID()}`
    await mkdir(pending)
    try {
      await extractRuntimeArchive(archive, pending)
      await readDesktopReleaseInstallation(pending, release)
      await rename(pending, root)
    } finally {
      await rm(pending, { recursive: true, force: true })
    }
  }
  return readDesktopReleaseInstallation(root, release)
}

export async function readDesktopReleaseInstallation(root, release) {
  const descriptor = JSON.parse(await readFile(join(root, 'wework-release.json'), 'utf8'))
  if (
    descriptor.schemaVersion !== 1 ||
    descriptor.fixture !== release.fixture ||
    descriptor.version !== release.version ||
    descriptor.sourceSha !== release.sourceSha ||
    descriptor.dataSchema !== release.dataSchema ||
    descriptor.afterStopPreparation !== release.afterStopPreparation
  )
    throw new Error('Published desktop archive does not match its release descriptor')
  const executable = await releasePath(root, descriptor.executable)
  const resources = await releasePath(root, descriptor.resources)
  const components = JSON.parse(await readFile(join(resources, 'components.json'), 'utf8'))
  if (components.afterStopPreparation !== release.afterStopPreparation)
    throw new Error('Published desktop stopped preparation capability does not match its package')
  const executor = join(
    resources,
    'bin',
    release.platform === 'windows' ? 'wegent-executor.exe' : 'wegent-executor'
  )
  const target =
    release.platform === 'windows'
      ? release.arch === 'arm64'
        ? 'aarch64-pc-windows-msvc'
        : 'x86_64-pc-windows-msvc'
      : release.arch === 'arm64'
        ? 'aarch64-apple-darwin'
        : 'x86_64-apple-darwin'
  const codex = join(
    resources,
    'codex/vendor',
    target,
    'bin',
    release.platform === 'windows' ? 'codex.exe' : 'codex'
  )
  await Promise.all([access(executable), access(executor), access(codex)])
  return { executable, executor, resources, codex }
}

/** Download and verify immutable bytes without rebuilding or extracting a package. */
export async function downloadPublishedDesktopArchive(options) {
  const { repository, version, platform, arch, directory, download = downloadAsset } = options
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !VERSION.test(version) ||
    !['macos', 'windows'].includes(platform) ||
    !['arm64', 'x64'].includes(arch)
  )
    throw new Error('Invalid published desktop release selection')
  await mkdir(directory, { recursive: true })
  const tag = `wework-v${version}`
  const descriptor = join(directory, `release-${platform}-${arch}.json`)
  if (!(await exists(descriptor)))
    await download(repository, tag, `release-${platform}-${arch}.json`, descriptor)
  const release = JSON.parse(await readFile(descriptor, 'utf8'))
  validateRelease(release, options)
  if (
    options.expected &&
    (release.sha256 !== options.expected.sha256 || release.sourceSha !== options.expected.sourceSha)
  )
    throw new Error('The historical source package changed')
  const archive = join(directory, release.name)
  if (!(await exists(archive))) {
    const pending = `${archive}.download-${randomUUID()}`
    try {
      await download(repository, tag, release.name, pending)
      await verifyArchive(pending, release)
      await rename(pending, archive)
    } finally {
      await rm(pending, { force: true })
    }
  }
  await verifyArchive(archive, release)
  return { ...release, path: archive }
}

/** Resolve an installed source from its unchanged delivered archive. */
export async function downloadPublishedDesktopRelease(options) {
  const release = await downloadPublishedDesktopArchive(options)
  const installation = await extractPublishedArchive(
    release.path,
    join(options.directory, 'source'),
    release
  )
  return { ...release, ...installation }
}

/** Verify and extract an existing producer artifact without changing its identity. */
export async function readPrebuiltDesktopRelease({
  directory,
  version,
  platform,
  arch,
  installation,
}) {
  const release = JSON.parse(
    await readFile(join(directory, `release-${platform}-${arch}.json`), 'utf8')
  )
  validateRelease(release, { version, platform, arch })
  const archive = join(directory, release.name)
  await verifyArchive(archive, release)
  await mkdir(dirname(installation), { recursive: true })
  return {
    ...release,
    path: archive,
    ...(await extractPublishedArchive(archive, installation, release)),
  }
}
