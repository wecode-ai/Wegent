import { createRequire } from 'node:module'
import { copyFile, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { prepareSharedElectronZip } from './electron-zip-cache.mjs'

/** Seed the official installer cache from the same verified ZIP used for packaging. */
export async function primeElectronInstallerCache({
  electronPackageRoot,
  environment = process.env,
  runtime = { arch: process.arch, platform: process.platform },
  downloadArtifact,
}) {
  const zipDirectory = await prepareSharedElectronZip({
    electronPackageRoot,
    environment,
    runtime,
    downloadArtifact,
  })
  const { version } = JSON.parse(await readFile(join(electronPackageRoot, 'package.json'), 'utf8'))
  const checksums = JSON.parse(await readFile(join(electronPackageRoot, 'checksums.json'), 'utf8'))
  const download =
    downloadArtifact ??
    createRequire(join(await realpath(electronPackageRoot), 'package.json'))('@electron/get')
      .downloadArtifact
  return download({
    version,
    artifactName: 'electron',
    platform: runtime.platform,
    arch: runtime.arch,
    cacheRoot: environment.electron_config_cache,
    checksums,
    downloader: {
      download: (_url, destination) =>
        copyFile(
          join(zipDirectory, `electron-v${version}-${runtime.platform}-${runtime.arch}.zip`),
          destination
        ),
    },
  })
}
