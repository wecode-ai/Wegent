import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFile, link, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export function resolveSharedElectronZipDirectory(
  environment = process.env,
  runtime = { platform: process.platform },
  baseDirectory = process.cwd()
) {
  const configuredDirectory = environment.WEWORK_ELECTRON_ZIP_DIR?.trim()
  if (configuredDirectory) return resolve(baseDirectory, configuredDirectory)

  if (environment.ELECTRON_CACHE?.trim()) {
    return join(resolve(baseDirectory, environment.ELECTRON_CACHE.trim()), 'wegent-zips')
  }
  if (runtime.platform === 'darwin') {
    return join(environment.HOME || tmpdir(), 'Library', 'Caches', 'wegent', 'electron-zips')
  }
  if (runtime.platform === 'win32') {
    return join(
      environment.LOCALAPPDATA || environment.USERPROFILE || tmpdir(),
      'wegent',
      'electron-zips'
    )
  }
  return join(
    environment.XDG_CACHE_HOME || join(environment.HOME || tmpdir(), '.cache'),
    'wegent',
    'electron-zips'
  )
}

async function sha256(path) {
  const hash = createHash('sha256')
  const input = await import('node:fs').then(fs => fs.createReadStream(path))
  for await (const chunk of input) hash.update(chunk)
  return hash.digest('hex')
}

async function matchesChecksum(path, expectedChecksum) {
  try {
    return (await sha256(path)) === expectedChecksum
  } catch {
    return false
  }
}

async function materializeFile(source, destination) {
  const temporaryPath = `${destination}.tmp-${process.pid}`
  await rm(temporaryPath, { force: true })
  try {
    await link(source, temporaryPath)
  } catch (error) {
    if (!['EXDEV', 'EPERM', 'EACCES'].includes(error?.code)) throw error
    await copyFile(source, temporaryPath)
  }
  await rename(temporaryPath, destination)
}

export async function prepareSharedElectronZip({
  electronPackageRoot,
  environment = process.env,
  runtime = { arch: process.arch, platform: process.platform },
  downloadArtifact,
}) {
  const packageJson = JSON.parse(await readFile(join(electronPackageRoot, 'package.json'), 'utf8'))
  const checksums = JSON.parse(await readFile(join(electronPackageRoot, 'checksums.json'), 'utf8'))
  const fileName = `electron-v${packageJson.version}-${runtime.platform}-${runtime.arch}.zip`
  const expectedChecksum = checksums[fileName]
  if (!expectedChecksum) throw new Error(`Electron checksum is missing for ${fileName}`)

  const zipDirectory = resolveSharedElectronZipDirectory(environment, runtime, electronPackageRoot)
  const destination = join(zipDirectory, fileName)
  if (await matchesChecksum(destination, expectedChecksum)) {
    console.log(`Reusing shared Electron ZIP: ${destination}`)
    return zipDirectory
  }

  const download =
    downloadArtifact ??
    createRequire(join(await realpath(electronPackageRoot), 'package.json'))('@electron/get')
      .downloadArtifact
  const cachedArtifact = await download({
    version: packageJson.version,
    artifactName: 'electron',
    platform: runtime.platform,
    arch: runtime.arch,
    checksums,
  })
  if (!(await matchesChecksum(cachedArtifact, expectedChecksum))) {
    throw new Error(`Electron ZIP checksum mismatch for ${fileName}`)
  }

  await mkdir(zipDirectory, { recursive: true })
  await rm(destination, { force: true })
  await materializeFile(cachedArtifact, destination)
  console.log(`Prepared shared Electron ZIP: ${destination}`)
  return zipDirectory
}
