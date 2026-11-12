import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { hashComponentPath, sha256 } from './component-content-hash.js'
import { publishImmutableDirectory } from './immutable-directory.js'
import { extractPhysicalRelease } from './physical-release-files.js'
import { runStartupStage, type StartupStageReporter } from './startup-stage.js'

export interface BundledComponentArchive {
  path: string
  sha256: string
  bytes: number
}

export interface BundledComponentArchiveMaterializationOptions {
  onStage?: StartupStageReporter
  stagePrefix?: string
}

/** Keep bundled small files inside one signed archive until target-owned preparation. */
export async function materializeBundledComponentArchive(
  resources: string,
  cache: string,
  archive: BundledComponentArchive,
  contentSha256: string,
  options: BundledComponentArchiveMaterializationOptions = {}
): Promise<string> {
  const stagePrefix = options.stagePrefix ?? 'component-archive'
  const source = resolve(resources, archive.path)
  await runStartupStage(options.onStage, `${stagePrefix}-source-verify`, async () => {
    const child = relative(resolve(resources), source)
    if (
      isAbsolute(archive.path) ||
      !child ||
      child === '..' ||
      child.startsWith('../') ||
      child.startsWith('..\\') ||
      isAbsolute(child) ||
      !/^[a-f0-9]{64}$/.test(archive.sha256) ||
      !/^[a-f0-9]{64}$/.test(contentSha256) ||
      !Number.isSafeInteger(archive.bytes) ||
      archive.bytes <= 0
    )
      throw new Error('Bundled component archive metadata is invalid')
    const physicalChild = relative(await realpath(resources), await realpath(source))
    if (
      physicalChild === '..' ||
      physicalChild.startsWith('../') ||
      physicalChild.startsWith('..\\') ||
      isAbsolute(physicalChild)
    )
      throw new Error('Bundled component archive escapes its package')
    const metadata = await stat(source)
    if (
      !metadata.isFile() ||
      metadata.size !== archive.bytes ||
      (await sha256(source)) !== archive.sha256
    )
      throw new Error('Bundled component archive integrity mismatch')
  })
  const matches = async (path: string) => {
    return runStartupStage(
      options.onStage,
      `${stagePrefix}-content-verify`,
      async () => {
        try {
          return (await hashComponentPath(await realpath(path))) === contentSha256
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        }
      },
      matched => ({ matched })
    )
  }
  const published = await publishImmutableDirectory(
    join(cache, archive.sha256),
    content =>
      runStartupStage(options.onStage, `${stagePrefix}-extract`, async () => {
        await extractPhysicalRelease(source, content)
        if (!(await matches(content)))
          throw new Error('Bundled component content checksum mismatch')
      }),
    matches
  )
  return realpath(published)
}
